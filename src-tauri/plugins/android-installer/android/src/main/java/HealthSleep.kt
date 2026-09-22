package app.hanni.mvp.android.installer

import android.app.Activity
import android.content.Context
import android.os.Build
import androidx.annotation.RequiresApi
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.HealthConnectFeatures
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.changes.DeletionChange
import androidx.health.connect.client.changes.UpsertionChange
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.request.ChangesTokenRequest
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.response.ReadRecordsResponse
import androidx.health.connect.client.time.TimeRangeFilter
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.time.Instant
import java.time.ZoneId
import java.util.concurrent.TimeUnit

@RequiresApi(28)
internal fun sleepStageTotals(stages: List<SleepSessionRecord.Stage>): Pair<Long?, Long?> {
    val sleepTypes = setOf(SleepSessionRecord.STAGE_TYPE_SLEEPING, SleepSessionRecord.STAGE_TYPE_LIGHT,
        SleepSessionRecord.STAGE_TYPE_DEEP, SleepSessionRecord.STAGE_TYPE_REM)
    val awakeTypes = setOf(SleepSessionRecord.STAGE_TYPE_AWAKE, SleepSessionRecord.STAGE_TYPE_AWAKE_IN_BED)
    fun duration(types: Set<Int>) = stages.filter { it.stage in types }
        .sumOf { it.endTime.toEpochMilli() - it.startTime.toEpochMilli() }
    if (stages.none { it.stage in sleepTypes || it.stage in awakeTypes }) return null to null
    return duration(sleepTypes) to duration(awakeTypes)
}

@RequiresApi(28)
internal suspend fun collectSleepRecords(read: suspend (String?) -> ReadRecordsResponse<SleepSessionRecord>): List<SleepSessionRecord> {
    val records = mutableListOf<SleepSessionRecord>()
    var page: String? = null
    var pages = 0
    do {
        check(++pages <= 100) { "health_sleep_page_limit" }
        val response = read(page)
        records.addAll(response.records)
        page = response.pageToken?.takeIf { it.isNotEmpty() }
    } while (page != null)
    return records
}

internal object SleepNative {
    private var loaded = false
    @Synchronized private fun load() {
        if (!loaded) { System.loadLibrary("hanni_mvp_lib"); loaded = true }
    }
    fun exchange(context: Context, batch: JSONObject? = null): JSONObject {
        load()
        val file = File(context.applicationInfo.dataDir, "calendar.db")
        check(file.isFile) { "health_sleep_storage_failed" }
        val result = JSONObject(exchangeNative(file.path, batch?.toString() ?: ""))
        check(!result.has("error")) { "health_sleep_storage_failed" }
        return result
    }
    @JvmStatic private external fun exchangeNative(path: String, batch: String): String
}

@RequiresApi(28)
internal object SleepImporter {
    private val mutex = Mutex()
    val readPermission = HealthPermission.getReadPermission(SleepSessionRecord::class)
    val backgroundPermission = HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND
    private const val DAY_MS = 86_400_000L

    fun available(context: Context): Boolean = Build.VERSION.SDK_INT >= 28 &&
        HealthConnectClient.getSdkStatus(context) == HealthConnectClient.SDK_AVAILABLE

    fun backgroundAvailable(client: HealthConnectClient): Boolean = client.features.getFeatureStatus(
        HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_IN_BACKGROUND
    ) == HealthConnectFeatures.FEATURE_STATUS_AVAILABLE

    suspend fun status(context: Context): JSONObject {
        if (!available(context)) return JSONObject().put("status", "provider_unavailable")
        val client = HealthConnectClient.getOrCreate(context)
        val permissions = client.permissionController.getGrantedPermissions()
        val granted = readPermission in permissions
        val background = backgroundAvailable(client)
        val backgroundGranted = background && backgroundPermission in permissions
        val state = SleepNative.exchange(context)
        state.remove("token")
        return state.put("status", if (granted) "ready" else "permission_required")
            .put("backgroundAvailable", background).put("backgroundGranted", backgroundGranted)
            .put("lastError", context.getSharedPreferences("hanni_sleep", Context.MODE_PRIVATE).getString("error", null))
    }

    // Stages are non-overlapping intervals supplied by Health Connect. Missing
    // stages mean unknown sleep time, never the entire session duration.
    private fun encode(record: SleepSessionRecord): JSONObject {
        val (asleep, awake) = sleepStageTotals(record.stages)
        return JSONObject().put("id", record.metadata.id).put("origin", record.metadata.dataOrigin.packageName)
            .put("startMs", record.startTime.toEpochMilli()).put("endMs", record.endTime.toEpochMilli())
            .put("offsetSeconds", (record.startZoneOffset ?: ZoneId.systemDefault().rules.getOffset(record.startTime)).totalSeconds)
            .put("asleepMs", asleep ?: JSONObject.NULL)
            .put("awakeMs", awake ?: JSONObject.NULL)
    }

    suspend fun sync(context: Context, background: Boolean): JSONObject = mutex.withLock {
        try {
            if (!available(context)) return@withLock JSONObject().put("status", "provider_unavailable")
            val client = HealthConnectClient.getOrCreate(context)
            val permissions = client.permissionController.getGrantedPermissions()
            val canBackground = backgroundAvailable(client) && backgroundPermission in permissions
            HanniSleepWorker.schedule(context, readPermission in permissions && canBackground)
            if (readPermission !in permissions || (background && !canBackground)) return@withLock status(context)
            var state = SleepNative.exchange(context)
            var token = state.optString("token").takeIf { state.has("token") && !state.isNull("token") && it.isNotEmpty() }
            var changed = 0
            withTimeout(90_000) {
                if (token == null || client.getChanges(token!!).changesTokenExpired) {
                    // Reserve the cursor before the snapshot so concurrent source
                    // changes will be replayed on the next Changes pass.
                    val next = client.getChangesToken(ChangesTokenRequest(setOf(SleepSessionRecord::class)))
                    val end = Instant.now()
                    val start = end.minusMillis(30 * DAY_MS)
                    val records = JSONArray(collectSleepRecords { page ->
                        client.readRecords(ReadRecordsRequest(SleepSessionRecord::class,
                            TimeRangeFilter.between(start, end), pageSize = 1000, pageToken = page))
                    }.map(::encode))
                    state = SleepNative.exchange(context, JSONObject().put("expectedToken", token ?: JSONObject.NULL)
                        .put("nextToken", next).put("records", records).put("deleted", JSONArray())
                        .put("snapshotStartMs", start.toEpochMilli()).put("snapshotEndMs", end.toEpochMilli()).put("complete", true))
                    changed += state.optInt("changed")
                    token = next
                }
                var pages = 0
                do {
                    check(++pages <= 100) { "health_sleep_page_limit" }
                    val response = client.getChanges(token!!)
                    check(!response.changesTokenExpired) { "health_sleep_cursor_expired" }
                    val records = linkedMapOf<String, JSONObject>()
                    val deleted = linkedSetOf<String>()
                    response.changes.forEach { change ->
                        when (change) {
                            is UpsertionChange -> (change.record as? SleepSessionRecord)?.let {
                                records[it.metadata.id] = encode(it); deleted.remove(it.metadata.id)
                            }
                            is DeletionChange -> { records.remove(change.recordId); deleted.add(change.recordId) }
                        }
                    }
                    state = SleepNative.exchange(context, JSONObject().put("expectedToken", token)
                        .put("nextToken", response.nextChangesToken).put("records", JSONArray(records.values.toList()))
                        .put("deleted", JSONArray(deleted.toList())).put("complete", !response.hasMore))
                    changed += state.optInt("changed")
                    token = response.nextChangesToken
                } while (response.hasMore)
            }
            context.getSharedPreferences("hanni_sleep", Context.MODE_PRIVATE).edit().remove("error").apply()
            status(context).put("changed", changed)
        } catch (error: CancellationException) {
            context.getSharedPreferences("hanni_sleep", Context.MODE_PRIVATE).edit().putString("error", "interrupted").apply()
            throw error
        } catch (_: SecurityException) {
            HanniSleepWorker.schedule(context, false)
            context.getSharedPreferences("hanni_sleep", Context.MODE_PRIVATE).edit().putString("error", "permission_required").apply()
            JSONObject().put("status", "permission_required")
        } catch (_: Exception) {
            context.getSharedPreferences("hanni_sleep", Context.MODE_PRIVATE).edit().putString("error", "import_failed").apply()
            JSONObject().put("status", "error").put("lastError", "import_failed")
        }
    }
}

@RequiresApi(28)
internal class SleepBridge(private val activity: Activity) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var launcher: ActivityResultLauncher<Set<String>>? = null
    fun register() {
        val host = activity as? ComponentActivity ?: return
        // Android may return through a recreated Activity. The permission screen
        // is only a launch acknowledgement; every import checks actual grants.
        launcher = host.activityResultRegistry.register("hanni_sleep_permission", PermissionController.createRequestPermissionResultContract()) { }
    }
    private fun respond(invoke: Invoke, action: suspend () -> JSONObject) {
        scope.launch {
            try { invoke.resolve(JSObject(withContext(Dispatchers.IO) { action().toString() })) }
            catch (_: Exception) { invoke.reject("health_sleep_unavailable") }
        }
    }
    fun status(invoke: Invoke) = respond(invoke) { SleepImporter.status(activity) }
    fun import(invoke: Invoke) = respond(invoke) {
        // The plugin constructor can retain the bootstrap Activity after Tauri
        // recreates its window. Observe the application's live Activities instead.
        if (!UpdateActivityGuard.hasStartedActivity()) {
            JSONObject().put("status", "foreground_required")
        } else SleepImporter.sync(activity.applicationContext, false)
    }
    fun connect(invoke: Invoke) {
        activity.runOnUiThread {
            if (launcher == null || !UpdateActivityGuard.hasStartedActivity()) { invoke.reject("health_sleep_foreground_required"); return@runOnUiThread }
            try {
                if (!SleepImporter.available(activity)) { invoke.resolve(JSObject().apply { put("status", "provider_unavailable") }); return@runOnUiThread }
                val client = HealthConnectClient.getOrCreate(activity)
                val permissions = mutableSetOf(SleepImporter.readPermission)
                if (SleepImporter.backgroundAvailable(client)) permissions.add(SleepImporter.backgroundPermission)
                launcher!!.launch(permissions)
                invoke.resolve(JSObject().apply { put("status", "permission_requested") })
            } catch (_: Exception) { invoke.reject("health_sleep_permission_failed") }
        }
    }
}

@RequiresApi(28)
class HanniSleepWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val result = SleepImporter.sync(applicationContext, true)
        if (result.optString("status") == "error") return@withContext if (runAttemptCount < 2) Result.retry() else Result.failure()
        // Uses the content transport's persisted enabled flag and OS lease.
        // Reading sleep remains useful offline and without remote sync configured.
        if (result.optString("status") == "ready") {
            try { ContentSyncNative.run(File(applicationContext.applicationInfo.dataDir, "calendar.db").path) }
            catch (_: Exception) { /* The independent content worker retries delivery. */ }
        }
        Result.success()
    }
    companion object {
        fun schedule(context: Context, enabled: Boolean) {
            val manager = WorkManager.getInstance(context)
            if (!enabled) { manager.cancelUniqueWork("hanni-sleep-import"); return }
            manager.enqueueUniquePeriodicWork("hanni-sleep-import", ExistingPeriodicWorkPolicy.KEEP,
                PeriodicWorkRequestBuilder<HanniSleepWorker>(15, TimeUnit.MINUTES).build())
        }
    }
}

class HealthSleepRationaleActivity : Activity() {
    override fun onCreate(savedInstanceState: android.os.Bundle?) {
        super.onCreate(savedInstanceState)
        val text = android.widget.TextView(this)
        text.setPadding(32, 48, 32, 32)
        text.text = "Сон в Hanni MVP\n\nПриложение читает только записи сна из Health Connect и сохраняет их в календаре. " +
            "Сон передаётся на другие устройства только при включённой синхронизации Hanni MVP. " +
            "Записи в Health Connect не изменяются. Разрешение можно отозвать в настройках Health Connect. " +
            "Уже импортированные записи при отзыве разрешения сохраняются."
        setContentView(text)
    }
}

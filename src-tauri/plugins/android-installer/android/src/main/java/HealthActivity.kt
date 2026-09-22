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
import androidx.health.connect.client.aggregate.AggregationResultGroupedByPeriod
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.request.AggregateGroupByPeriodRequest
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
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.Period
import java.time.ZoneId
import java.util.concurrent.TimeUnit

@RequiresApi(28)
internal fun shouldImportWalking(exerciseType: Int): Boolean = exerciseType == ExerciseSessionRecord.EXERCISE_TYPE_WALKING

internal fun stepSnapshotDates(today: LocalDate): Pair<LocalDate, LocalDate> =
    today.minusDays(30L - 1L) to today.plusDays(1)

internal fun encodeStepAggregate(row: AggregationResultGroupedByPeriod): JSONObject? {
    val count = row.result[StepsRecord.COUNT_TOTAL] ?: return null
    return JSONObject().put("date", row.startTime.toLocalDate().toString())
        .put("count", count).put("originScope", "all")
}

@RequiresApi(28)
internal suspend fun collectWalkingRecords(read: suspend (String?) -> ReadRecordsResponse<ExerciseSessionRecord>): List<ExerciseSessionRecord> {
    val records = mutableListOf<ExerciseSessionRecord>()
    var page: String? = null
    var pages = 0
    do {
        check(++pages <= 100) { "health_activity_page_limit" }
        val response = read(page)
        records.addAll(response.records.filter { shouldImportWalking(it.exerciseType) })
        page = response.pageToken?.takeIf { it.isNotEmpty() }
    } while (page != null)
    return records
}

internal object ActivityNative {
    private var loaded = false
    @Synchronized private fun load() { if (!loaded) { System.loadLibrary("hanni_mvp_lib"); loaded = true } }
    fun exchange(context: Context, batch: JSONObject? = null): JSONObject {
        load()
        val file = File(context.applicationInfo.dataDir, "calendar.db")
        check(file.isFile) { "health_activity_storage_failed" }
        val result = JSONObject(exchangeNative(file.path, batch?.toString() ?: ""))
        check(!result.has("error")) { "health_activity_storage_failed" }
        return result
    }
    @JvmStatic private external fun exchangeNative(path: String, batch: String): String
}

@RequiresApi(28)
internal object ActivityImporter {
    private val mutex = Mutex()
    val walkingPermission = HealthPermission.getReadPermission(ExerciseSessionRecord::class)
    val stepsPermission = HealthPermission.getReadPermission(StepsRecord::class)
    val backgroundPermission = HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND
    private const val DAY_COUNT = 30L

    fun available(context: Context): Boolean = Build.VERSION.SDK_INT >= 28 && HealthConnectClient.getSdkStatus(context) == HealthConnectClient.SDK_AVAILABLE
    fun backgroundAvailable(client: HealthConnectClient): Boolean = client.features.getFeatureStatus(HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_IN_BACKGROUND) == HealthConnectFeatures.FEATURE_STATUS_AVAILABLE

    suspend fun status(context: Context): JSONObject {
        if (!available(context)) return JSONObject().put("status", "provider_unavailable")
        val client = HealthConnectClient.getOrCreate(context)
        val permissions = client.permissionController.getGrantedPermissions()
        val walkingGranted = walkingPermission in permissions
        val stepsGranted = stepsPermission in permissions
        val background = backgroundAvailable(client)
        val state = ActivityNative.exchange(context)
        state.remove("token")
        return state.put("status", if (walkingGranted || stepsGranted) "ready" else "permission_required")
            .put("walkingPermissionGranted", walkingGranted).put("stepsPermissionGranted", stepsGranted)
            .put("backgroundAvailable", background).put("backgroundGranted", background && backgroundPermission in permissions)
            .put("lastError", context.getSharedPreferences("hanni_health_activity", Context.MODE_PRIVATE).getString("error", null))
    }

    private fun encodeWalking(record: ExerciseSessionRecord): JSONObject = JSONObject()
        .put("id", record.metadata.id).put("origin", record.metadata.dataOrigin.packageName)
        .put("startMs", record.startTime.toEpochMilli()).put("endMs", record.endTime.toEpochMilli())
        .put("offsetSeconds", (record.startZoneOffset ?: ZoneId.systemDefault().rules.getOffset(record.startTime)).totalSeconds)

    private suspend fun encodeSteps(client: HealthConnectClient, start: LocalDateTime, end: LocalDateTime): JSONArray {
        val rows = client.aggregateGroupByPeriod(AggregateGroupByPeriodRequest(
            metrics = setOf(StepsRecord.COUNT_TOTAL),
            timeRangeFilter = TimeRangeFilter.between(start, end),
            timeRangeSlicer = Period.ofDays(1)))
        return JSONArray(rows.mapNotNull(::encodeStepAggregate))
    }

    suspend fun sync(context: Context, background: Boolean): JSONObject = mutex.withLock {
        try {
            if (!available(context)) return@withLock JSONObject().put("status", "provider_unavailable")
            val client = HealthConnectClient.getOrCreate(context)
            val permissions = client.permissionController.getGrantedPermissions()
            val walkingGranted = walkingPermission in permissions
            val stepsGranted = stepsPermission in permissions
            val canBackground = backgroundAvailable(client) && backgroundPermission in permissions
            ActivityWorker.schedule(context, (walkingGranted || stepsGranted) && canBackground)
            if (background && !canBackground) return@withLock status(context)
            if (!walkingGranted && !stepsGranted) return@withLock status(context)
            val state = ActivityNative.exchange(context)
            val oldToken = state.optString("token").takeIf { state.has("token") && !state.isNull("token") && it.isNotEmpty() }
            var changed = 0
            withTimeout(90_000) {
                // A bounded snapshot reconciles source updates/deletions in its
                // window. The local token records the committed snapshot only;
                // it is not a Health Connect changes token.
                val end = Instant.now()
                val start = end.minusSeconds(DAY_COUNT * 86_400)
                val today = LocalDate.now()
                val (stepStart, stepEnd) = stepSnapshotDates(today)
                val walking = if (walkingGranted) JSONArray(collectWalkingRecords { page ->
                    client.readRecords(ReadRecordsRequest(ExerciseSessionRecord::class, TimeRangeFilter.between(start, end), pageSize = 1000, pageToken = page))
                }.map(::encodeWalking)) else JSONArray()
                val steps = if (stepsGranted) encodeSteps(client, stepStart.atStartOfDay(), stepEnd.atStartOfDay()) else JSONArray()
                val applied = ActivityNative.exchange(context, JSONObject().put("expectedToken", oldToken ?: JSONObject.NULL)
                    .put("nextToken", "snapshot:${end.toEpochMilli()}").put("walkingGranted", walkingGranted).put("stepsGranted", stepsGranted)
                    .put("walking", walking).put("steps", steps).put("deletedWalking", JSONArray()).put("deletedSteps", JSONArray())
                    .put("snapshotStartMs", start.toEpochMilli()).put("snapshotEndMs", end.toEpochMilli())
                    .put("stepsSnapshotStartDate", stepStart.toString()).put("stepsSnapshotEndDate", stepEnd.toString()).put("complete", true))
                changed += applied.optInt("changed")
            }
            context.getSharedPreferences("hanni_health_activity", Context.MODE_PRIVATE).edit().remove("error").apply()
            status(context).put("changed", changed)
        } catch (error: CancellationException) {
            context.getSharedPreferences("hanni_health_activity", Context.MODE_PRIVATE).edit().putString("error", "interrupted").apply()
            throw error
        } catch (_: SecurityException) {
            ActivityWorker.schedule(context, false)
            context.getSharedPreferences("hanni_health_activity", Context.MODE_PRIVATE).edit().putString("error", "permission_required").apply()
            JSONObject().put("status", "permission_required")
        } catch (_: Exception) {
            context.getSharedPreferences("hanni_health_activity", Context.MODE_PRIVATE).edit().putString("error", "import_failed").apply()
            JSONObject().put("status", "error").put("lastError", "import_failed")
        }
    }
}

@RequiresApi(28)
internal class ActivityBridge(private val activity: Activity) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var launcher: ActivityResultLauncher<Set<String>>? = null
    fun register() {
        val host = activity as? ComponentActivity ?: return
        launcher = host.activityResultRegistry.register("hanni_health_activity_permission", PermissionController.createRequestPermissionResultContract()) { }
    }
    private fun respond(invoke: Invoke, action: suspend () -> JSONObject) {
        scope.launch {
            try { invoke.resolve(JSObject(withContext(Dispatchers.IO) { action().toString() })) }
            catch (_: Exception) { invoke.reject("health_activity_unavailable") }
        }
    }
    fun status(invoke: Invoke) = respond(invoke) { ActivityImporter.status(activity) }
    fun import(invoke: Invoke) = respond(invoke) {
        if (!UpdateActivityGuard.hasStartedActivity()) JSONObject().put("status", "foreground_required")
        else ActivityImporter.sync(activity.applicationContext, false)
    }
    fun connect(invoke: Invoke) {
        scope.launch {
            if (launcher == null || !UpdateActivityGuard.hasStartedActivity()) { invoke.reject("health_activity_foreground_required"); return@launch }
            try {
                if (!ActivityImporter.available(activity)) { invoke.resolve(JSObject().apply { put("status", "provider_unavailable") }); return@launch }
                val client = HealthConnectClient.getOrCreate(activity)
                val permissions = mutableSetOf(ActivityImporter.walkingPermission, ActivityImporter.stepsPermission)
                if (ActivityImporter.backgroundAvailable(client)) permissions.add(ActivityImporter.backgroundPermission)
                val requested = requestMissingHealthPermissions(
                    permissions,
                    { withContext(Dispatchers.IO) { client.permissionController.getGrantedPermissions() } },
                    { missing ->
                        if (!UpdateActivityGuard.hasStartedActivity()) throw IllegalStateException("activity_not_started")
                        launcher!!.launch(missing)
                    })
                if (requested) invoke.resolve(JSObject().apply { put("status", "permission_requested") })
                else invoke.resolve(JSObject(withContext(Dispatchers.IO) { ActivityImporter.status(activity).toString() }))
            } catch (_: Exception) { invoke.reject("health_activity_permission_failed") }
        }
    }
}

@RequiresApi(28)
class ActivityWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val result = ActivityImporter.sync(applicationContext, true)
        if (result.optString("status") == "error") return@withContext if (runAttemptCount < 2) Result.retry() else Result.failure()
        if (result.optString("status") == "ready") {
            try { ContentSyncNative.run(File(applicationContext.applicationInfo.dataDir, "calendar.db").path) } catch (_: Exception) { }
        }
        Result.success()
    }
    companion object {
        fun schedule(context: Context, enabled: Boolean) {
            val manager = WorkManager.getInstance(context)
            if (!enabled) { manager.cancelUniqueWork("hanni-health-activity-import"); return }
            manager.enqueueUniquePeriodicWork("hanni-health-activity-import", ExistingPeriodicWorkPolicy.KEEP,
                PeriodicWorkRequestBuilder<ActivityWorker>(15, TimeUnit.MINUTES).build())
        }
    }
}

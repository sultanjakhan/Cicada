package app.hanni.mvp.android.installer

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.util.concurrent.TimeUnit

internal object ContentSyncCodes {
    const val SUCCESS = 0
    const val RETRY = 1
    const val SKIP = 2
    const val BUSY = 3
    const val FAILURE = 4
}

internal object ContentSyncRetryPolicy {
    const val MAX_ATTEMPTS = 3
    fun shouldRetry(code: Int, runAttemptCount: Int): Boolean =
        (code == ContentSyncCodes.RETRY || code == ContentSyncCodes.BUSY) && runAttemptCount + 1 < MAX_ATTEMPTS
}

internal object ContentSyncSchedulePolicy {
    fun shouldSchedule(enabled: Boolean): Boolean = enabled
}

/** Closed-app content sync. It never creates an Activity or notification. */
class HanniContentSyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        UpdateActivityGuard.install(applicationContext as android.app.Application)
        if (UpdateActivityGuard.hasLiveActivity()) {
            ContentSyncReceipt.save(applicationContext, ContentSyncCodes.SUCCESS)
            return@withContext Result.success()
        }
        val database = File(applicationContext.applicationInfo.dataDir, "calendar.db").canonicalFile
        if (!database.isFile) {
            ContentSyncReceipt.save(applicationContext, ContentSyncCodes.SKIP)
            return@withContext Result.success()
        }
        val code = try { ContentSyncNative.run(database.path) }
        catch (_: LinkageError) { ContentSyncCodes.FAILURE }
        catch (_: Exception) { ContentSyncCodes.FAILURE }
        ContentSyncReceipt.save(applicationContext, code)
        if (ContentSyncRetryPolicy.shouldRetry(code, runAttemptCount)) Result.retry()
        else Result.success()
    }

    companion object {
        private const val UNIQUE_WORK = "hanni-content-sync"
        fun schedule(context: Context, enabled: Boolean): Boolean {
            val manager = WorkManager.getInstance(context)
            if (!ContentSyncSchedulePolicy.shouldSchedule(enabled)) {
                manager.cancelUniqueWork(UNIQUE_WORK)
                return false
            }
            val constraints = Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .setRequiresBatteryNotLow(true)
                .setRequiresStorageNotLow(true)
                .build()
            val request = PeriodicWorkRequestBuilder<HanniContentSyncWorker>(15, TimeUnit.MINUTES)
                .setConstraints(constraints).build()
            manager.enqueueUniquePeriodicWork(UNIQUE_WORK, ExistingPeriodicWorkPolicy.KEEP, request)
            return true
        }
    }
}

internal object ContentSyncNative {
    private var loaded = false
    @Synchronized private fun load() {
        if (!loaded) {
            System.loadLibrary("hanni_mvp_lib")
            loaded = true
        }
    }
    fun run(databasePath: String): Int { load(); return runNative(databasePath) }
    @JvmStatic private external fun runNative(databasePath: String): Int
}

internal object ContentSyncReceipt {
    private const val PREFS = "hanni_content_sync"
    private const val LAST_RUN_AT = "last_run_at_ms"
    private const val LAST_CODE = "last_status_code"
    fun save(context: Context, code: Int) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putLong(LAST_RUN_AT, System.currentTimeMillis()).putInt(LAST_CODE, code).apply()
    }
}

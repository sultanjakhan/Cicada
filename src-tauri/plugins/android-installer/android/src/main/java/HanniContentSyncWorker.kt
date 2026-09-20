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
    const val SKIP_FOREGROUND = 5
}

internal enum class ContentSyncOutcome {
    SUCCESS,
    RETRY,
    FAILURE,
}

internal object ContentSyncResultPolicy {
    const val MAX_ATTEMPTS = 3
    fun outcome(code: Int, runAttemptCount: Int): ContentSyncOutcome = when (code) {
        ContentSyncCodes.SUCCESS,
        ContentSyncCodes.SKIP,
        ContentSyncCodes.SKIP_FOREGROUND -> ContentSyncOutcome.SUCCESS
        ContentSyncCodes.RETRY,
        ContentSyncCodes.BUSY -> if (runAttemptCount + 1 < MAX_ATTEMPTS) {
            ContentSyncOutcome.RETRY
        } else {
            ContentSyncOutcome.FAILURE
        }
        else -> ContentSyncOutcome.FAILURE
    }
}

/** Closed-app content sync. It never creates an Activity or notification. */
class HanniContentSyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        UpdateActivityGuard.install(applicationContext as android.app.Application)
        if (UpdateActivityGuard.hasStartedActivity()) {
            ContentSyncReceipt.save(applicationContext, ContentSyncCodes.SKIP_FOREGROUND)
            return@withContext Result.success()
        }
        val code = try {
            val database = File(applicationContext.applicationInfo.dataDir, "calendar.db").canonicalFile
            if (!database.isFile) ContentSyncCodes.SKIP else ContentSyncNative.run(database.path)
        } catch (_: LinkageError) {
            ContentSyncCodes.FAILURE
        } catch (_: Exception) {
            ContentSyncCodes.FAILURE
        }
        ContentSyncReceipt.save(applicationContext, code)
        when (ContentSyncResultPolicy.outcome(code, runAttemptCount)) {
            ContentSyncOutcome.SUCCESS -> Result.success()
            ContentSyncOutcome.RETRY -> Result.retry()
            ContentSyncOutcome.FAILURE -> Result.failure()
        }
    }

    companion object {
        private const val UNIQUE_WORK = "hanni-content-sync"
        fun schedule(context: Context, enabled: Boolean): Boolean {
            val manager = WorkManager.getInstance(context)
            if (!enabled) {
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
            .putLong(LAST_RUN_AT, System.currentTimeMillis()).putInt(LAST_CODE, code).commit()
    }
}

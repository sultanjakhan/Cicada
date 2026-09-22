package app.hanni.mvp.android.installer

import android.app.Activity
import android.app.Application
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.security.MessageDigest

internal const val STATUS_LAUNCHED = "launched"
internal const val STATUS_PERMISSION_REQUIRED = "permission_required"
internal const val STATUS_INSTALLING = "installing"
internal const val STATUS_PENDING_USER_ACTION = "pending_user_action"
internal const val STATUS_SUCCESS = "success"
internal const val STATUS_FAILURE = "failure"
internal const val STATUS_IDLE = "idle"
internal const val INSTALL_RESULT_ACTION = "app.hanni.mvp.android.installer.INSTALL_RESULT"
internal const val EXTRA_CALLBACK_TOKEN = "callback_token"
private const val PREFS_NAME = "hanni_android_installer"
private const val PREF_STATUS = "status"
private const val PREF_SESSION_ID = "session_id"
private const val PREF_TOKEN = "callback_token"
private const val PREF_STATUS_CODE = "status_code"
private const val PREF_STATUS_MESSAGE = "status_message"
private const val PREF_UPDATED_AT = "updated_at"
private const val PREF_PENDING_INTENT = "pending_intent"
private const val PREF_VERSION_CODE = "version_code"

// A distinct provider class prevents manifest-merger collisions with Tauri's
// own FileProvider and preserves this provider's private updates-only paths.
class HanniUpdateFileProvider : FileProvider()

internal object InstallPolicy {
    const val expectedPackageId = "app.hanni.mvp"
    const val maxApkBytes = 160L * 1024L * 1024L

    fun isLowercaseSha256(value: String): Boolean = value.matches(Regex("[0-9a-f]{64}"))

    fun isUnderUpdatesRoot(updatesRoot: File, candidate: File): Boolean =
        candidate.path.startsWith(updatesRoot.path + File.separator)

    fun hasAllowedSize(size: Long): Boolean = size in 1..maxApkBytes

    fun usesUnattendedSession(apiLevel: Int, automatic: Boolean): Boolean =
        automatic && apiLevel >= Build.VERSION_CODES.S

    fun acceptsCallback(expectedSessionId: Int, expectedToken: String, sessionId: Int, token: String?): Boolean =
        expectedSessionId == sessionId && expectedToken.isNotBlank() && expectedToken == token
}

@InvokeArg
class InstallVerifiedArgs {
    lateinit var path: String
    var expectedVersionCode: Long = 0
    lateinit var expectedSha256: String
    var automatic: Boolean = false
}

/** Receives only the explicit PendingIntent created by this plugin. */
class HanniUpdateResultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != INSTALL_RESULT_ACTION) return
        val store = InstallStatusStore(context)
        val expectedSession = store.sessionId()
        val sessionId = intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1)
        if (!InstallPolicy.acceptsCallback(expectedSession, store.token(), sessionId, intent.getStringExtra(EXTRA_CALLBACK_TOKEN))) {
            return
        }

        val code = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        if (store.isTerminalFor(sessionId)) return
        val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
        when (code) {
            PackageInstaller.STATUS_SUCCESS -> store.save(STATUS_SUCCESS, sessionId, code, message)
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                val userIntent = intent.parcelableIntent(Intent.EXTRA_INTENT)
                if (userIntent == null) {
                    store.save(STATUS_FAILURE, sessionId, code, "Android requested user action without an intent")
                } else {
                    store.save(STATUS_PENDING_USER_ACTION, sessionId, code, message, userIntent.toUri(0))
                }
            }
            else -> store.save(STATUS_FAILURE, sessionId, code, message)
        }
    }
}

internal class InstallStatusStore(context: Context) {
    private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun save(status: String, sessionId: Int, code: Int? = null, message: String? = null, pendingIntent: String? = null, versionCode: Long? = null) {
        prefs.edit()
            .putString(PREF_STATUS, status)
            .putInt(PREF_SESSION_ID, sessionId)
            .putInt(PREF_STATUS_CODE, code ?: Int.MIN_VALUE)
            .putString(PREF_STATUS_MESSAGE, message)
            .putLong(PREF_UPDATED_AT, System.currentTimeMillis())
            .apply {
                if (pendingIntent == null) remove(PREF_PENDING_INTENT) else putString(PREF_PENDING_INTENT, pendingIntent)
                if (versionCode != null) putLong(PREF_VERSION_CODE, versionCode)
            }
            .apply()
    }

    fun sessionId(): Int = prefs.getInt(PREF_SESSION_ID, -1)
    fun versionCode(): Long = prefs.getLong(PREF_VERSION_CODE, 0)
    fun updatedAtMs(): Long = prefs.getLong(PREF_UPDATED_AT, 0)
    fun token(): String = prefs.getString(PREF_TOKEN, "") ?: ""
    /** One durable state transition before PackageInstaller can issue a callback. */
    fun beginSession(sessionId: Int, token: String, versionCode: Long) {
        prefs.edit()
            .putString(PREF_TOKEN, token)
            .putString(PREF_STATUS, STATUS_INSTALLING)
            .putInt(PREF_SESSION_ID, sessionId)
            .putInt(PREF_STATUS_CODE, Int.MIN_VALUE)
            .remove(PREF_STATUS_MESSAGE)
            .remove(PREF_PENDING_INTENT)
            .putLong(PREF_UPDATED_AT, System.currentTimeMillis())
            .putLong(PREF_VERSION_CODE, versionCode)
            .commit()
    }
    fun isTerminalFor(sessionId: Int): Boolean = sessionId() == sessionId && prefs.getString(PREF_STATUS, STATUS_IDLE) in setOf(STATUS_SUCCESS, STATUS_FAILURE)
    fun pendingUserIntent(): String? = prefs.getString(PREF_PENDING_INTENT, null)
    fun status(): JSObject = JSObject().apply {
        put("status", prefs.getString(PREF_STATUS, STATUS_IDLE))
        put("sessionId", sessionId())
        put("statusCode", prefs.getInt(PREF_STATUS_CODE, Int.MIN_VALUE))
        put("statusMessage", prefs.getString(PREF_STATUS_MESSAGE, null))
        put("updatedAtMs", prefs.getLong(PREF_UPDATED_AT, 0))
        put("versionCode", prefs.getLong(PREF_VERSION_CODE, 0))
    }
}

/**
 * Last native boundary before handing a verified update to Android's package
 * installer. It does not download an APK. Completion comes only from the
 * PackageInstaller callback persisted by HanniUpdateResultReceiver.
 */
@TauriPlugin
class AndroidInstallerPlugin(private val activity: Activity) : Plugin(activity) {
    init {
        UpdateActivityGuard.install(activity.application, activity)
    }
    @get:androidx.annotation.RequiresApi(28)
    private val sleepBridge by lazy { if (Build.VERSION.SDK_INT >= 28) SleepBridge(activity) else null }
    @get:androidx.annotation.RequiresApi(28)
    private val activityBridge by lazy { if (Build.VERSION.SDK_INT >= 28) ActivityBridge(activity) else null }
    override fun load(webView: android.webkit.WebView) {
        if (Build.VERSION.SDK_INT >= 28) { sleepBridge?.register(); activityBridge?.register() }
    }
    @Command fun sleepStatus(invoke: Invoke) { if (Build.VERSION.SDK_INT >= 28) sleepBridge?.status(invoke) else invoke.resolve(status("provider_unavailable")) }
    @Command fun sleepConnect(invoke: Invoke) { if (Build.VERSION.SDK_INT >= 28) sleepBridge?.connect(invoke) else invoke.resolve(status("provider_unavailable")) }
    @Command fun sleepImport(invoke: Invoke) { if (Build.VERSION.SDK_INT >= 28) sleepBridge?.import(invoke) else invoke.resolve(status("provider_unavailable")) }
    @Command fun activityStatus(invoke: Invoke) { if (Build.VERSION.SDK_INT >= 28) activityBridge?.status(invoke) else invoke.resolve(status("provider_unavailable")) }
    @Command fun activityConnect(invoke: Invoke) { if (Build.VERSION.SDK_INT >= 28) activityBridge?.connect(invoke) else invoke.resolve(status("provider_unavailable")) }
    @Command fun activityImport(invoke: Invoke) { if (Build.VERSION.SDK_INT >= 28) activityBridge?.import(invoke) else invoke.resolve(status("provider_unavailable")) }
    @Command
    fun installVerified(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(InstallVerifiedArgs::class.java)
            val apk = validateCandidate(args)

            if (args.automatic && Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
                // Android 7–11 cannot request unattended sessions. Never start
                // a confirmation Activity from a background automatic request.
                invoke.resolve(status("unsupported"))
                return
            }
            if (!canRequestPackageInstalls()) {
                InstallStatusStore(activity).save(STATUS_PERMISSION_REQUIRED, -1, message = "Android install permission is required", versionCode = args.expectedVersionCode)
                invoke.resolve(status(STATUS_PERMISSION_REQUIRED))
                return
            }

            if (InstallPolicy.usesUnattendedSession(Build.VERSION.SDK_INT, args.automatic)) {
                WorkerSession.commit(activity, apk, args.expectedVersionCode)
                invoke.resolve(status(STATUS_INSTALLING))
            } else {
                launchLegacyInstaller(apk)
                invoke.resolve(status(STATUS_LAUNCHED))
            }
        } catch (error: Exception) {
            invoke.reject(error.message ?: "Could not prepare Android system installer")
        }
    }

    /** Explicit UI action only. installVerified never opens settings itself. */
    @Command
    fun openInstallPermission(invoke: Invoke) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !canRequestPackageInstalls()) {
                val intent = Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:${activity.packageName}"),
                ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                activity.startActivity(intent)
            }
            invoke.resolve(status(STATUS_LAUNCHED))
        } catch (error: Exception) {
            invoke.reject(error.message ?: "Could not open Android install permission settings")
        }
    }

    /** Returns the last PackageInstaller result saved in private app storage. */
    @Command
    fun getInstallStatus(invoke: Invoke) {
        WorkerSession.reconcile(activity)
        invoke.resolve(InstallStatusStore(activity).status())
    }

    @Command
    fun scheduleAutoInstall(invoke: Invoke) {
        try {
            invoke.resolve(JSObject().apply {
                put("scheduled", HanniAutoUpdateWorker.schedule(activity.applicationContext))
                if (!UpdateConfiguration.isConfigured()) put("reason", "update_channel_unconfigured")
            })
        } catch (error: Exception) {
            invoke.reject(error.message ?: "Could not schedule automatic Android updates")
        }
    }

    @Command
    fun scheduleContentSync(invoke: Invoke) {
        try {
            val enabled = invoke.parseArgs(ContentSyncScheduleArgs::class.java).enabled
            invoke.resolve(JSObject().apply {
                put("scheduled", HanniContentSyncWorker.schedule(activity.applicationContext, enabled))
            })
        } catch (error: Exception) {
            invoke.reject(error.message ?: "Could not schedule content sync")
        }
    }

    /** Explicit UI action for the rare OS fallback after STATUS_PENDING_USER_ACTION. */
    @Command
    fun openPendingUserAction(invoke: Invoke) {
        try {
            val store = InstallStatusStore(activity)
            require(store.status().getString("status") == STATUS_PENDING_USER_ACTION) { "No Android confirmation is pending" }
            val serialized = requireNotNull(store.pendingUserIntent()) { "Pending Android confirmation intent is unavailable" }
            val intent = Intent.parseUri(serialized, 0).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            activity.startActivity(intent)
            invoke.resolve(status(STATUS_LAUNCHED))
        } catch (error: Exception) {
            invoke.reject(error.message ?: "Could not open Android confirmation")
        }
    }

    private fun launchLegacyInstaller(apk: File) {
        val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.android-installer", apk)
        activity.startActivity(Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        })
    }

    private fun validateCandidate(args: InstallVerifiedArgs): File {
        require(args.expectedVersionCode > 0) { "Expected version code must be positive" }
        require(InstallPolicy.isLowercaseSha256(args.expectedSha256)) {
            "Expected APK SHA-256 must be 64 lowercase hexadecimal characters"
        }

        val updatesRoot = File(activity.cacheDir, "updates").canonicalFile
        val apk = File(args.path).canonicalFile
        require(InstallPolicy.isUnderUpdatesRoot(updatesRoot, apk)) {
            "APK must be stored below the private cache updates directory"
        }
        require(apk.isFile) { "APK candidate is not a file" }
        require(InstallPolicy.hasAllowedSize(apk.length())) { "APK candidate size is outside the allowed limit" }
        require(sha256(apk) == args.expectedSha256) { "APK SHA-256 does not match the verified manifest" }

        val packageManager = activity.packageManager
        val archive = packageManager.getPackageArchiveInfo(apk.path, signingFlags())
            ?: throw IllegalArgumentException("APK archive metadata is unreadable")
        require(archive.packageName == InstallPolicy.expectedPackageId) { "APK package id is not Cicada" }

        val archiveVersionCode = versionCode(archive)
        require(archiveVersionCode == args.expectedVersionCode) {
            "APK version code does not match the verified manifest"
        }

        val installed = packageManager.getPackageInfo(InstallPolicy.expectedPackageId, signingFlags())
        val installedVersionCode = versionCode(installed)
        require(archiveVersionCode > installedVersionCode) { "APK is not newer than the installed Cicada" }
        require(certificateDigests(archive) == certificateDigests(installed)) {
            "APK signing certificate does not match the installed Cicada"
        }
        return apk
    }

    @Suppress("DEPRECATION")
    private fun signingFlags(): Int = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        PackageManager.GET_SIGNING_CERTIFICATES
    } else {
        PackageManager.GET_SIGNATURES
    }

    @Suppress("DEPRECATION")
    private fun versionCode(info: PackageInfo): Long = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        info.longVersionCode
    } else {
        info.versionCode.toLong()
    }

    @Suppress("DEPRECATION")
    private fun certificateDigests(info: PackageInfo): Set<String> {
        val signatures = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            info.signingInfo?.apkContentsSigners ?: emptyArray()
        } else {
            info.signatures ?: emptyArray()
        }
        require(signatures.isNotEmpty()) { "APK signing certificate is missing" }
        return signatures.map { signature ->
            MessageDigest.getInstance("SHA-256").digest(signature.toByteArray()).toHex()
        }.toSet()
    }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().buffered().use { input ->
            val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                digest.update(buffer, 0, count)
            }
        }
        return digest.digest().toHex()
    }

    private fun ByteArray.toHex(): String = joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }

    private fun canRequestPackageInstalls(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.O || activity.packageManager.canRequestPackageInstalls()

    private fun status(value: String): JSObject = JSObject().apply { put("status", value) }

}

@InvokeArg
class ContentSyncScheduleArgs { var enabled: Boolean = false }

@Suppress("DEPRECATION")
private fun Intent.parcelableIntent(key: String): Intent? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
    getParcelableExtra(key, Intent::class.java)
} else {
    getParcelableExtra(key)
}

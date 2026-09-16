package app.hanni.mvp.android.installer

import android.app.Activity
import android.app.PendingIntent
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
import java.security.SecureRandom

private const val STATUS_LAUNCHED = "launched"
private const val STATUS_PERMISSION_REQUIRED = "permission_required"
private const val STATUS_INSTALLING = "installing"
private const val STATUS_PENDING_USER_ACTION = "pending_user_action"
private const val STATUS_SUCCESS = "success"
private const val STATUS_FAILURE = "failure"
private const val STATUS_IDLE = "idle"
private const val INSTALL_RESULT_ACTION = "app.hanni.mvp.android.installer.INSTALL_RESULT"
private const val EXTRA_CALLBACK_TOKEN = "callback_token"
private const val PREFS_NAME = "hanni_android_installer"
private const val PREF_STATUS = "status"
private const val PREF_SESSION_ID = "session_id"
private const val PREF_TOKEN = "callback_token"
private const val PREF_STATUS_CODE = "status_code"
private const val PREF_STATUS_MESSAGE = "status_message"
private const val PREF_UPDATED_AT = "updated_at"
private const val PREF_PENDING_INTENT = "pending_intent"

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

private class InstallStatusStore(context: Context) {
    private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun save(status: String, sessionId: Int, code: Int? = null, message: String? = null, pendingIntent: String? = null) {
        prefs.edit()
            .putString(PREF_STATUS, status)
            .putInt(PREF_SESSION_ID, sessionId)
            .putInt(PREF_STATUS_CODE, code ?: Int.MIN_VALUE)
            .putString(PREF_STATUS_MESSAGE, message)
            .putLong(PREF_UPDATED_AT, System.currentTimeMillis())
            .apply {
                if (pendingIntent == null) remove(PREF_PENDING_INTENT) else putString(PREF_PENDING_INTENT, pendingIntent)
            }
            .apply()
    }

    fun sessionId(): Int = prefs.getInt(PREF_SESSION_ID, -1)
    fun token(): String = prefs.getString(PREF_TOKEN, "") ?: ""
    fun setToken(token: String) = prefs.edit().putString(PREF_TOKEN, token).apply()
    fun pendingUserIntent(): String? = prefs.getString(PREF_PENDING_INTENT, null)
    fun status(): JSObject = JSObject().apply {
        put("status", prefs.getString(PREF_STATUS, STATUS_IDLE))
        put("sessionId", sessionId())
        put("statusCode", prefs.getInt(PREF_STATUS_CODE, Int.MIN_VALUE))
        put("statusMessage", prefs.getString(PREF_STATUS_MESSAGE, null))
        put("updatedAtMs", prefs.getLong(PREF_UPDATED_AT, 0))
    }
}

/**
 * Last native boundary before handing a verified update to Android's package
 * installer. It does not download an APK. Completion comes only from the
 * PackageInstaller callback persisted by HanniUpdateResultReceiver.
 */
@TauriPlugin
class AndroidInstallerPlugin(private val activity: Activity) : Plugin(activity) {
    @Command
    fun installVerified(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(InstallVerifiedArgs::class.java)
            val apk = validateCandidate(args)

            if (!canRequestPackageInstalls()) {
                invoke.resolve(status(STATUS_PERMISSION_REQUIRED))
                return
            }

            if (InstallPolicy.usesUnattendedSession(Build.VERSION.SDK_INT, args.automatic)) {
                invoke.resolve(commitUnattendedInstall(apk))
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
        invoke.resolve(InstallStatusStore(activity).status())
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

    private fun commitUnattendedInstall(apk: File): JSObject {
        val installer = activity.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(InstallPolicy.expectedPackageId)
            setSize(apk.length())
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
            }
        }
        val sessionId = installer.createSession(params)
        val store = InstallStatusStore(activity)
        val token = newCallbackToken()
        store.setToken(token)
        store.save(STATUS_INSTALLING, sessionId)
        try {
            installer.openSession(sessionId).use { session ->
                apk.inputStream().use { input ->
                    session.openWrite("base.apk", 0, apk.length()).use { output ->
                        input.copyTo(output)
                        session.fsync(output)
                    }
                }
                val callbackIntent = Intent(activity, HanniUpdateResultReceiver::class.java).apply {
                    action = INSTALL_RESULT_ACTION
                    setPackage(activity.packageName)
                    putExtra(EXTRA_CALLBACK_TOKEN, token)
                }
                val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
                val callback = PendingIntent.getBroadcast(activity, sessionId, callbackIntent, flags)
                session.commit(callback.intentSender)
            }
        } catch (error: Exception) {
            installer.abandonSession(sessionId)
            store.save(STATUS_FAILURE, sessionId, message = error.message)
            throw error
        }
        return status(STATUS_INSTALLING)
    }

    private fun launchLegacyInstaller(apk: File) {
        val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.android-installer", apk)
        activity.startActivity(Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        })
    }

    private fun newCallbackToken(): String = ByteArray(32).also { SecureRandom().nextBytes(it) }.toHex()

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
        require(archive.packageName == InstallPolicy.expectedPackageId) { "APK package id is not Hanni MVP" }

        val archiveVersionCode = versionCode(archive)
        require(archiveVersionCode == args.expectedVersionCode) {
            "APK version code does not match the verified manifest"
        }

        val installed = packageManager.getPackageInfo(InstallPolicy.expectedPackageId, signingFlags())
        val installedVersionCode = versionCode(installed)
        require(archiveVersionCode > installedVersionCode) { "APK is not newer than the installed Hanni MVP" }
        require(certificateDigests(archive) == certificateDigests(installed)) {
            "APK signing certificate does not match the installed Hanni MVP"
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

    @Suppress("DEPRECATION")
    private fun Intent.parcelableIntent(key: String): Intent? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        getParcelableExtra(key, Intent::class.java)
    } else {
        getParcelableExtra(key)
    }
}

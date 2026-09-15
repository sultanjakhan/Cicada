package app.hanni.mvp.android.installer

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
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

private const val STATUS_LAUNCHED = "launched"
private const val STATUS_PERMISSION_REQUIRED = "permission_required"

internal object InstallPolicy {
    const val expectedPackageId = "app.hanni.mvp"
    const val maxApkBytes = 160L * 1024L * 1024L

    fun isLowercaseSha256(value: String): Boolean = value.matches(Regex("[0-9a-f]{64}"))

    fun isUnderUpdatesRoot(updatesRoot: File, candidate: File): Boolean =
        candidate.path.startsWith(updatesRoot.path + File.separator)

    fun hasAllowedSize(size: Long): Boolean = size in 1..maxApkBytes
}

@InvokeArg
class InstallVerifiedArgs {
    lateinit var path: String
    var expectedVersionCode: Long = 0
    lateinit var expectedSha256: String
}

/**
 * Last native boundary before handing a verified update to Android's package
 * installer. It does not download an APK and does not report installation as
 * complete: Android owns confirmation, cancellation and final outcome.
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

            val uri = FileProvider.getUriForFile(
                activity,
                "${activity.packageName}.android-installer",
                apk,
            )
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            activity.startActivity(intent)
            invoke.resolve(status(STATUS_LAUNCHED))
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
}

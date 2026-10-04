package app.hanni.mvp.android.installer

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URI
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/** Closed-app updater. It never starts an Activity and gives up while any UI exists. */
class HanniAutoUpdateWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        UpdateActivityGuard.install(applicationContext as android.app.Application)
        if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.S || UpdateActivityGuard.hasLiveActivity()) return@withContext Result.success()
        if (!UpdateConfiguration.isConfigured()) return@withContext Result.success()
        val store = InstallStatusStore(applicationContext)
        if (WorkerSession.reconcile(applicationContext) in setOf(STATUS_INSTALLING, STATUS_PENDING_USER_ACTION)) return@withContext Result.success()
        try {
            val manifest = JSONObject(fetch(UpdateConfiguration.url(), 64 * 1024))
            val manifestVersion = manifest.getString("version")
            val packageInfo = manifest.getJSONObject("platforms").getJSONObject("android-aarch64")
            val versionCode = packageInfo.getLong("version_code")
            val url = packageInfo.getString("url")
            val signature = packageInfo.getString("signature")
            val sha256 = packageInfo.getString("sha256")
            val size = packageInfo.getLong("size")
            require(manifestVersionCode(manifestVersion) == versionCode) { "Manifest Android version is inconsistent" }
            if (!ClosedUpdatePolicy.shouldDownload(InstalledVersion.code(applicationContext), versionCode)) return@withContext Result.success()
            require(size in 1..InstallPolicy.maxApkBytes && InstallPolicy.isLowercaseSha256(sha256))
            require(UpdateConfiguration.isAllowedPackageUrl(url))
            val updates = File(applicationContext.cacheDir, "updates").apply { mkdirs() }
            val apk = File(updates, "hanni-mvp-$manifestVersion.package")
            if (!apk.isFile || apk.length() != size || sha256(apk) != sha256) {
                val temporary = File(updates, "${apk.name}.part")
                download(url, temporary, size)
                require(sha256(temporary) == sha256) { "Downloaded APK hash differs" }
                MinisignVerifier.verifyFile(temporary, UpdateConfiguration.publicKey(), signature)
                require(VerifiedApk.validate(applicationContext, temporary, versionCode, sha256)) { "Downloaded APK identity changed" }
                require(temporary.renameTo(apk)) { "Could not save verified update" }
            }
            require(sha256(apk) == sha256) { "Downloaded APK hash differs" }
            MinisignVerifier.verifyFile(apk, UpdateConfiguration.publicKey(), signature)
            require(VerifiedApk.validate(applicationContext, apk, versionCode, sha256)) { "Downloaded APK identity changed" }
            if (UpdateActivityGuard.hasLiveActivity()) return@withContext Result.success()
            // A background job never creates a PackageInstaller session.
            // Foreground checks offer the release after app entry.
            val receipt = preparedUpdateMetadata(manifestVersion, packageInfo)
            val temporary = File(updates, "prepared.android.part")
            temporary.writeText(receipt.toString())
            require(temporary.renameTo(File(updates, "prepared.json"))) { "Could not save update metadata" }
            Result.success()
        } catch (_: TransientUpdateException) { Result.retry() }
        catch (_: java.io.IOException) { store.save(STATUS_FAILURE, store.sessionId(), message = "Network update check failed"); Result.retry() }
        catch (error: Exception) { store.save(STATUS_FAILURE, store.sessionId(), message = error.message); Result.success() }
    }

    companion object {
        private const val UNIQUE_WORK = "hanni-automatic-update"
        fun schedule(context: Context): Boolean {
            if (!UpdateConfiguration.isConfigured()) return false
            val constraints = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).setRequiresBatteryNotLow(true).setRequiresStorageNotLow(true).build()
            val request = PeriodicWorkRequestBuilder<HanniAutoUpdateWorker>(6, TimeUnit.HOURS)
                .setConstraints(constraints).setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(UNIQUE_WORK, ExistingPeriodicWorkPolicy.KEEP, request)
            return true
        }
    }
}

internal object UpdateConfiguration {
    fun isConfigured() = try { val feed = URI(BuildConfig.HANNI_MVP_UPDATES_URL); feed.scheme == "https" && feed.userInfo == null && feed.rawQuery == null && feed.rawFragment == null && BuildConfig.HANNI_MVP_UPDATES_TOKEN.length >= 32 && BuildConfig.HANNI_MVP_UPDATE_PUBLIC_KEY.isNotBlank() } catch (_: Exception) { false }
    fun url(): String = BuildConfig.HANNI_MVP_UPDATES_URL
    fun publicKey(): String = BuildConfig.HANNI_MVP_UPDATE_PUBLIC_KEY
    fun isAllowedPackageUrl(value: String): Boolean {
        val feed = URI(url()); val candidate = URI(value)
        return candidate.scheme == "https" && candidate.rawQuery == null && candidate.rawFragment == null && candidate.userInfo == null && candidate.host == feed.host && candidate.port == feed.port && candidate.path.startsWith("/releases/")
    }
    fun authorization() = "Bearer ${BuildConfig.HANNI_MVP_UPDATES_TOKEN}"
}
internal object ClosedUpdatePolicy {
    fun shouldDownload(installedVersionCode: Long, manifestVersionCode: Long): Boolean = manifestVersionCode > installedVersionCode
}
// Same private cache contract as Rust PreparedUpdate. Native code revalidates
// the candidate, hash and pinned signature before reusing the package.
internal fun preparedUpdateMetadata(version: String, packageInfo: JSONObject): JSONObject =
    JSONObject().put("candidate", JSONObject().put("version", version).put("package", packageInfo))
        .put("prepared_at", java.time.Instant.now().toString())
private fun manifestVersionCode(version: String): Long {
    val parts = Regex("^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$").matchEntire(version)?.groupValues ?: throw IllegalArgumentException("Invalid release version")
    val major = parts[1].toLong(); val minor = parts[2].toLong(); val patch = parts[3].toLong()
    require(minor < 1000 && patch < 1000)
    return Math.addExact(Math.addExact(Math.multiplyExact(major, 1_000_000), Math.multiplyExact(minor, 1_000)), patch)
}

private class TransientUpdateException : Exception()
private fun fetch(url: String, limit: Int): String {
    val connection = (URI(url).toURL().openConnection() as HttpURLConnection).apply { instanceFollowRedirects = false; connectTimeout = 15_000; readTimeout = 180_000; setRequestProperty("Authorization", UpdateConfiguration.authorization()) }
    try { require(connection.responseCode in 200..299) { throw TransientUpdateException() }; return connection.inputStream.use { input -> readBounded(input, limit).toString(Charsets.UTF_8) } } finally { connection.disconnect() }
}
private fun download(url: String, destination: File, expected: Long) {
    val connection = (URI(url).toURL().openConnection() as HttpURLConnection).apply { instanceFollowRedirects = false; connectTimeout = 15_000; readTimeout = 180_000; setRequestProperty("Authorization", UpdateConfiguration.authorization()) }
    try { require(connection.responseCode in 200..299) { throw TransientUpdateException() }; require(connection.contentLengthLong !in (expected + 1)..Long.MAX_VALUE); connection.inputStream.use { input -> destination.outputStream().use { output -> copyBounded(input, output, expected) } }; require(destination.length() == expected) } finally { connection.disconnect() }
}
private fun readBounded(input: java.io.InputStream, limit: Int): ByteArray = java.io.ByteArrayOutputStream().use { output -> copyBounded(input, output, limit.toLong()); output.toByteArray() }
private fun copyBounded(input: java.io.InputStream, output: java.io.OutputStream, limit: Long) { val buffer = ByteArray(DEFAULT_BUFFER_SIZE); var total = 0L; while (true) { val count = input.read(buffer); if (count < 0) return; total += count; require(total <= limit) { "Update response exceeds bound" }; output.write(buffer, 0, count) } }
private fun sha256(file: File): String = MessageDigest.getInstance("SHA-256").digest(file.readBytes()).joinToString("") { "%02x".format(it.toInt() and 0xff) }
private object InstalledVersion {
    @Suppress("DEPRECATION") fun code(context: Context): Long {
        val info = context.packageManager.getPackageInfo(InstallPolicy.expectedPackageId, 0)
        return if (android.os.Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()
    }
}

/** Second identity check after download; installer validation still runs in the foreground path. */
private object VerifiedApk {
    @Suppress("DEPRECATION") fun validate(context: Context, apk: File, expectedVersion: Long, expectedHash: String): Boolean {
        val flags = if (android.os.Build.VERSION.SDK_INT >= 28) android.content.pm.PackageManager.GET_SIGNING_CERTIFICATES else android.content.pm.PackageManager.GET_SIGNATURES
        val pm = context.packageManager; val archive = pm.getPackageArchiveInfo(apk.path, flags) ?: return false
        val installed = pm.getPackageInfo(InstallPolicy.expectedPackageId, flags)
        val archiveCode = if (android.os.Build.VERSION.SDK_INT >= 28) archive.longVersionCode else archive.versionCode.toLong()
        val installedCode = if (android.os.Build.VERSION.SDK_INT >= 28) installed.longVersionCode else installed.versionCode.toLong()
        return archive.packageName == InstallPolicy.expectedPackageId && archiveCode == expectedVersion && archiveCode > installedCode && sha256(apk) == expectedHash && signerDigests(archive) == signerDigests(installed)
    }
    private fun signerDigests(info: android.content.pm.PackageInfo): Set<String> {
        val signatures = if (android.os.Build.VERSION.SDK_INT >= 28) info.signingInfo?.apkContentsSigners ?: emptyArray() else info.signatures ?: emptyArray()
        return signatures.map { signature -> MessageDigest.getInstance("SHA-256").digest(signature.toByteArray()).joinToString("") { "%02x".format(it.toInt() and 0xff) } }.toSet()
    }
}

internal object WorkerSession {
    @Synchronized fun reconcile(context: Context): String {
        val store = InstallStatusStore(context)
        val current = store.status().getString("status")
        if (current == STATUS_PERMISSION_REQUIRED && context.packageManager.canRequestPackageInstalls()) {
            store.save(STATUS_IDLE, -1, versionCode = store.versionCode().takeIf { it > 0 })
            return STATUS_IDLE
        }
        if (current != STATUS_INSTALLING) return current
        val id = store.sessionId()
        val session = context.packageManager.packageInstaller.getSessionInfo(id)
        if (session != null) {
            val abandonedBeforeCommit = !session.isSealed && !session.isActive &&
                System.currentTimeMillis() - store.updatedAtMs() > 5 * 60 * 1000
            if (!abandonedBeforeCommit) return current
            context.packageManager.packageInstaller.abandonSession(id)
        }
        val expectedVersion = store.versionCode()
        val resolved = if (expectedVersion > 0 && InstalledVersion.code(context) >= expectedVersion) STATUS_SUCCESS else STATUS_FAILURE
        store.save(resolved, id, message = if (resolved == STATUS_FAILURE) "Android installation session disappeared" else null)
        return resolved
    }

}

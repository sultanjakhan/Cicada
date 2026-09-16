package app.hanni.mvp.android.installer

import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.database.sqlite.SQLiteDatabase
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
        if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.S || UpdateActivityGuard.hasLiveActivity()) return@withContext Result.success()
        if (!UpdateConfiguration.isConfigured()) return@withContext Result.success()
        val store = InstallStatusStore(applicationContext)
        if (store.status().getString("status") in setOf(STATUS_INSTALLING, STATUS_PENDING_USER_ACTION)) return@withContext Result.success()
        try {
            val manifest = JSONObject(fetch(UpdateConfiguration.url(), 64 * 1024))
            val packageInfo = manifest.getJSONObject("platforms").getJSONObject("android-aarch64")
            val versionCode = packageInfo.getLong("version_code")
            val url = packageInfo.getString("url")
            val signature = packageInfo.getString("signature")
            val sha256 = packageInfo.getString("sha256")
            val size = packageInfo.getLong("size")
            require(size in 1..InstallPolicy.maxApkBytes && InstallPolicy.isLowercaseSha256(sha256))
            require(UpdateConfiguration.isAllowedPackageUrl(url))
            val updates = File(applicationContext.cacheDir, "updates").apply { mkdirs() }
            val apk = File(updates, "pending.apk")
            download(url, apk, size)
            require(sha256(apk) == sha256) { "Downloaded APK hash differs" }
            MinisignVerifier.verifyFile(apk, UpdateConfiguration.publicKey(), signature)
            require(VerifiedApk.validate(applicationContext, apk, versionCode, sha256)) { "Downloaded APK identity changed" }
            backupDatabase(applicationContext)
            WorkerSession.commit(applicationContext, apk, versionCode)
            Result.success()
        } catch (_: TransientUpdateException) { Result.retry() }
        catch (_: Exception) { Result.success() }
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
    fun isConfigured() = BuildConfig.HANNI_MVP_UPDATES_URL.isNotBlank() && BuildConfig.HANNI_MVP_UPDATES_TOKEN.length >= 32 && BuildConfig.HANNI_MVP_UPDATE_PUBLIC_KEY.isNotBlank()
    fun url(): String = BuildConfig.HANNI_MVP_UPDATES_URL
    fun publicKey(): String = BuildConfig.HANNI_MVP_UPDATE_PUBLIC_KEY
    fun isAllowedPackageUrl(value: String): Boolean {
        val feed = URI(url()); val candidate = URI(value)
        return candidate.scheme == "https" && candidate.rawQuery == null && candidate.rawFragment == null && candidate.userInfo == null && candidate.host == feed.host && candidate.port == feed.port && candidate.path.startsWith("/releases/")
    }
    fun authorization() = "Bearer ${BuildConfig.HANNI_MVP_UPDATES_TOKEN}"
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
private fun backupDatabase(context: Context) {
    val dataDir = context.dataDir.canonicalFile
    val source = File(dataDir, "calendar.db").canonicalFile
    require(source.parentFile == dataDir && source.isFile) { "Hanni calendar database is unavailable" }
    val directory = File(dataDir, "backups").canonicalFile.apply { mkdirs() }
    val destination = File(directory, "calendar-before-auto-update-${System.currentTimeMillis()}.db")
    SQLiteDatabase.openDatabase(source.path, null, SQLiteDatabase.OPEN_READWRITE).use { database ->
        database.execSQL("VACUUM INTO '${destination.path.replace("'", "''")}'")
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

private object WorkerSession {
    @Synchronized fun commit(context: Context, apk: File, versionCode: Long) {
        val existing = InstallStatusStore(context).status().getString("status")
        if (existing == STATUS_INSTALLING || existing == STATUS_PENDING_USER_ACTION) return
        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply { setAppPackageName(InstallPolicy.expectedPackageId); setSize(apk.length()); setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED) }
        val id = installer.createSession(params); val token = ByteArray(32).also { java.security.SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it.toInt() and 0xff) }; val store = InstallStatusStore(context); store.beginSession(id, token, versionCode)
        installer.openSession(id).use { session -> apk.inputStream().use { input -> session.openWrite("base.apk", 0, apk.length()).use { output -> input.copyTo(output); session.fsync(output) } }; val intent = Intent(context, HanniUpdateResultReceiver::class.java).apply { action = INSTALL_RESULT_ACTION; setPackage(context.packageName); putExtra(EXTRA_CALLBACK_TOKEN, token) }; val pending = android.app.PendingIntent.getBroadcast(context, id, intent, android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_MUTABLE); session.commit(pending.intentSender) }
    }
}

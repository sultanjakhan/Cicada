package app.hanni.mvp.android.installer

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class InstallPolicyTest {
    @Test
    fun acceptsOnlyLowercaseSha256() {
        assertTrue(InstallPolicy.isLowercaseSha256("a".repeat(64)))
        assertFalse(InstallPolicy.isLowercaseSha256("A".repeat(64)))
        assertFalse(InstallPolicy.isLowercaseSha256("a".repeat(63)))
    }

    @Test
    fun acceptsOnlyDirectoriesBelowTheDedicatedUpdatesRoot() {
        val cache = Files.createTempDirectory("hanni-installer-test").toFile()
        val updates = File(cache, "updates").apply { mkdirs() }.canonicalFile
        assertTrue(InstallPolicy.isUnderUpdatesRoot(updates, File(updates, "candidate.apk").canonicalFile))
        assertFalse(InstallPolicy.isUnderUpdatesRoot(updates, File(cache, "candidate.apk").canonicalFile))
        assertFalse(InstallPolicy.isUnderUpdatesRoot(updates, updates))
    }

    @Test
    fun rejectsEmptyAndOversizedCandidates() {
        assertFalse(InstallPolicy.hasAllowedSize(0))
        assertTrue(InstallPolicy.hasAllowedSize(1))
        assertTrue(InstallPolicy.hasAllowedSize(InstallPolicy.maxApkBytes))
        assertFalse(InstallPolicy.hasAllowedSize(InstallPolicy.maxApkBytes + 1))
    }
}

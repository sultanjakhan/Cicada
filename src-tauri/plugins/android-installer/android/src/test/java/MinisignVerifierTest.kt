package app.hanni.mvp.android.installer

import android.util.Base64
import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertThrows
import org.junit.Test

class MinisignVerifierTest {
    private val publicKey = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDMxNEQ0QjJGMjhGNTU4NDAKUldSQVdQVW9MMHROTVVING1XMVp6VnJKTEM4NVFGS3R5amN3eXl2b0ZwVy8xQVNUNmhMSDh3c08K"
    private val signature = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVSQVdQVW9MMHROTVZCRTAzOHdZM2RYc1JqTEtDaE50MmFwWDZYbGlRVVNkSDBra20xZHBtOVQ5a1pPVkduTUJ6SDZHVkR2M2hiSHhBNkdtWXBxdXJqZDlVQ1RwMERGS1E4PQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzg5NTA4MzEwCWZpbGU6c2FtcGxlLnR4dAo4ekMxYi9rS0xxbUFWNHNzekhGdTk4bXdWRjZLOVRoRjNRWiswWC9ETU5FS2ZEbW81Zzd1MWUvK1ErV2UrK08yNGxHc0VaMG9RQXZOWEVLUjhMUnVBUT09Cg=="

    @Test
    fun verifiesTheSamePrehashedMinisignFixtureAsRust() {
        val file = Files.createTempFile("hanni-minisign", ".txt").toFile()
        file.writeText("Fictional update verifier test.")
        MinisignVerifier.verifyFile(file, decode(publicKey), decode(signature))
    }

    @Test
    fun rejectsATamperedGlobalSignature() {
        val file = Files.createTempFile("hanni-minisign", ".txt").toFile()
        file.writeText("Fictional update verifier test.")
        val lines = decode(signature).trimEnd().lines().toMutableList()
        lines[3] = lines[3].dropLast(1) + "A"
        assertThrows(IllegalArgumentException::class.java) { MinisignVerifier.verifyFile(file, decode(publicKey), lines.joinToString("\n")) }
    }

    private fun decode(value: String): String = Base64.decode(value, Base64.NO_WRAP).toString(Charsets.UTF_8)
}

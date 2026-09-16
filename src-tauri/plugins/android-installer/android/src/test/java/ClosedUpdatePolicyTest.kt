package app.hanni.mvp.android.installer

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ClosedUpdatePolicyTest {
    @Test
    fun doesNotDownloadTheInstalledOrAnOlderRelease() {
        assertFalse(ClosedUpdatePolicy.shouldDownload(3_010_000, 3_010_000))
        assertFalse(ClosedUpdatePolicy.shouldDownload(3_010_000, 3_009_999))
    }

    @Test
    fun downloadsOnlyANewerRelease() {
        assertTrue(ClosedUpdatePolicy.shouldDownload(3_010_000, 3_010_001))
    }
}

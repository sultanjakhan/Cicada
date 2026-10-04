package app.hanni.mvp.android.installer

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.assertEquals
import org.json.JSONObject
import org.junit.Test

class ClosedUpdatePolicyTest {
    @Test
    fun preparedPackageUsesTheNativeCacheContractWithoutInstalling() {
        val packageInfo = JSONObject().put("url", "https://updates.example/releases/app.apk")
            .put("size", 100).put("sha256", "a".repeat(64)).put("signature", "fixture")
            .put("version_code", 9_008_007)
        val saved = preparedUpdateMetadata("9.8.7", packageInfo)
        assertEquals("9.8.7", saved.getJSONObject("candidate").getString("version"))
        assertEquals(packageInfo.toString(), saved.getJSONObject("candidate").getJSONObject("package").toString())
        assertTrue(saved.getString("prepared_at"), saved.getString("prepared_at").matches(Regex("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$")))
    }
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

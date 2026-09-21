package app.hanni.mvp.android.installer

import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.response.ReadRecordsResponse
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

class HealthSleepTest {
    @Test fun stagesDoNotCountAwakeOrUnknownTimeAsSleep() {
        fun stage(start: Long, end: Long, type: Int) = SleepSessionRecord.Stage(
            Instant.ofEpochSecond(start), Instant.ofEpochSecond(end), type)
        val totals = sleepStageTotals(listOf(
            stage(0, 60, SleepSessionRecord.STAGE_TYPE_AWAKE_IN_BED),
            stage(60, 180, SleepSessionRecord.STAGE_TYPE_LIGHT),
            stage(180, 240, SleepSessionRecord.STAGE_TYPE_DEEP),
            stage(240, 300, SleepSessionRecord.STAGE_TYPE_REM),
            stage(300, 360, SleepSessionRecord.STAGE_TYPE_UNKNOWN)))
        assertEquals(240_000L to 60_000L, totals)
        assertEquals(null to null, sleepStageTotals(emptyList()))
        assertEquals(null to null, sleepStageTotals(listOf(stage(0, 60, SleepSessionRecord.STAGE_TYPE_UNKNOWN))))
    }

    @Test fun paginationStopsOnBothProviderTerminalForms() = runBlocking {
        for (terminal in listOf(null, "")) {
            val tokens = mutableListOf<String?>()
            collectSleepRecords { token ->
                tokens.add(token)
                ReadRecordsResponse(emptyList(), if (token == null) "next" else terminal)
            }
            assertEquals(listOf(null, "next"), tokens)
        }
    }

    @Test fun interruptedSnapshotCannotBecomeAnEmptySuccessfulResult() = runBlocking {
        var calls = 0
        try {
            collectSleepRecords {
                calls++
                if (calls == 2) throw SecurityException("fictional revocation")
                ReadRecordsResponse(emptyList(), "next")
            }
            fail("A partial snapshot must not be returned")
        } catch (_: SecurityException) { assertEquals(2, calls) }
    }
}

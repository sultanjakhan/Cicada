package app.hanni.mvp.android.installer

import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.aggregate.AggregationResult
import androidx.health.connect.client.aggregate.AggregationResultGroupedByPeriod
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.metadata.Metadata
import androidx.health.connect.client.response.ReadRecordsResponse
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate
import java.time.Instant
import java.time.ZoneOffset

class HealthActivityTest {
    @Test fun onlyWalkingExerciseSessionsAreImported() {
        assertTrue(shouldImportWalking(ExerciseSessionRecord.EXERCISE_TYPE_WALKING))
        assertFalse(shouldImportWalking(ExerciseSessionRecord.EXERCISE_TYPE_RUNNING))
    }

    @Test fun absentAggregateMetricStaysAbsentButExplicitZeroIsKept() {
        fun row(count: Long?) = AggregationResultGroupedByPeriod(
            AggregationResult(
                longValues = if (count == null) emptyMap() else mapOf("Steps_count_total" to count),
                doubleValues = emptyMap(),
                dataOrigins = emptySet()),
            LocalDate.of(2026, 9, 22).atStartOfDay(), LocalDate.of(2026, 9, 23).atStartOfDay())
        assertNull(encodeStepAggregate(row(null)))
        assertEquals(0L, encodeStepAggregate(row(0L))?.getLong("count"))
        assertEquals(3210L, encodeStepAggregate(row(3210L))?.getLong("count"))
    }

    @Test fun stepWindowIsThirtyLocalCalendarDaysAndIncludesToday() {
        val (start, end) = stepSnapshotDates(LocalDate.of(2026, 9, 22))
        assertEquals(LocalDate.of(2026, 8, 24), start)
        assertEquals(LocalDate.of(2026, 9, 23), end)
    }

    @Test fun walkingPaginationFiltersOtherExerciseAndPropagatesProviderFailure() = runBlocking {
        fun record(type: Int) = ExerciseSessionRecord(
            startTime = Instant.parse("2026-09-22T08:00:00Z"), startZoneOffset = ZoneOffset.UTC,
            endTime = Instant.parse("2026-09-22T09:00:00Z"), endZoneOffset = ZoneOffset.UTC,
            metadata = Metadata.manualEntry(), exerciseType = type)
        val pages = mutableListOf<String?>()
        val records = collectWalkingRecords { token ->
            pages += token
            if (token == null) ReadRecordsResponse(listOf(record(ExerciseSessionRecord.EXERCISE_TYPE_WALKING), record(ExerciseSessionRecord.EXERCISE_TYPE_RUNNING)), "next")
            else ReadRecordsResponse(listOf(record(ExerciseSessionRecord.EXERCISE_TYPE_WALKING)), null)
        }
        assertEquals(listOf(null, "next"), pages)
        assertEquals(2, records.size)
        try {
            collectWalkingRecords { throw SecurityException("synthetic provider failure") }
            throw AssertionError("provider failure must propagate")
        } catch (_: SecurityException) { }
    }
}

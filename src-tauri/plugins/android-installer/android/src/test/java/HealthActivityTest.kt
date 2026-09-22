package app.hanni.mvp.android.installer

import androidx.health.connect.client.records.ExerciseSessionRecord
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate

class HealthActivityTest {
    @Test fun onlyWalkingExerciseSessionsAreImported() {
        assertTrue(shouldImportWalking(ExerciseSessionRecord.EXERCISE_TYPE_WALKING))
        assertFalse(shouldImportWalking(ExerciseSessionRecord.EXERCISE_TYPE_RUNNING))
    }

    @Test fun absentAggregateMetricStaysAbsentButExplicitZeroIsKept() {
        assertNull(stepCountOrAbsent(null))
        assertEquals(0L, stepCountOrAbsent(0L))
        assertEquals(3210L, stepCountOrAbsent(3210L))
    }

    @Test fun stepWindowIsThirtyLocalCalendarDaysAndIncludesToday() {
        val (start, end) = stepSnapshotDates(LocalDate.of(2026, 9, 22))
        assertEquals(LocalDate.of(2026, 8, 24), start)
        assertEquals(LocalDate.of(2026, 9, 23), end)
    }
}

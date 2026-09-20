package app.hanni.mvp.android.installer

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ContentSyncPolicyTest {
    @Test fun retriesTransientAndBusyBeforeTheThirdAttempt() {
        assertTrue(ContentSyncRetryPolicy.shouldRetry(ContentSyncCodes.RETRY, 0))
        assertTrue(ContentSyncRetryPolicy.shouldRetry(ContentSyncCodes.BUSY, 1))
        assertFalse(ContentSyncRetryPolicy.shouldRetry(ContentSyncCodes.BUSY, 2))
        assertFalse(ContentSyncRetryPolicy.shouldRetry(ContentSyncCodes.BUSY, 3))
    }

    @Test fun doesNotRetrySkipOrPermanentFailure() {
        assertFalse(ContentSyncRetryPolicy.shouldRetry(ContentSyncCodes.SKIP, 0))
        assertFalse(ContentSyncRetryPolicy.shouldRetry(ContentSyncCodes.FAILURE, 0))
    }

    @Test fun disabledSyncCancelsInsteadOfScheduling() {
        assertTrue(ContentSyncSchedulePolicy.shouldSchedule(true))
        assertFalse(ContentSyncSchedulePolicy.shouldSchedule(false))
    }
}

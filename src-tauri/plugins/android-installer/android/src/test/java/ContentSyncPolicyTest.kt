package app.hanni.mvp.android.installer

import org.junit.Assert.assertEquals
import org.junit.Test

class ContentSyncPolicyTest {
    @Test fun successSkipAndForegroundSkipCompleteWithoutRetry() {
        listOf(ContentSyncCodes.SUCCESS, ContentSyncCodes.SKIP, ContentSyncCodes.SKIP_FOREGROUND).forEach { code ->
            assertEquals(ContentSyncOutcome.SUCCESS, ContentSyncResultPolicy.outcome(code, 0))
            assertEquals(ContentSyncOutcome.SUCCESS, ContentSyncResultPolicy.outcome(code, 9))
        }
    }

    @Test fun transientAndBusyRetryOnlyBeforeThirdAttempt() {
        listOf(ContentSyncCodes.RETRY, ContentSyncCodes.BUSY).forEach { code ->
            assertEquals(ContentSyncOutcome.RETRY, ContentSyncResultPolicy.outcome(code, 0))
            assertEquals(ContentSyncOutcome.RETRY, ContentSyncResultPolicy.outcome(code, 1))
            assertEquals(ContentSyncOutcome.FAILURE, ContentSyncResultPolicy.outcome(code, 2))
            assertEquals(ContentSyncOutcome.FAILURE, ContentSyncResultPolicy.outcome(code, 3))
        }
    }

    @Test fun permanentAndUnknownCodesFailWithoutRetry() {
        assertEquals(ContentSyncOutcome.FAILURE, ContentSyncResultPolicy.outcome(ContentSyncCodes.FAILURE, 0))
        assertEquals(ContentSyncOutcome.FAILURE, ContentSyncResultPolicy.outcome(99, 0))
    }
}

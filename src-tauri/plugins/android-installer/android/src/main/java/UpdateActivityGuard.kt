package app.hanni.mvp.android.installer

import android.app.Activity
import android.app.Application
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/** The periodic worker must only mutate an application that is actually closed. */
internal object UpdateActivityGuard : Application.ActivityLifecycleCallbacks {
    private val installed = AtomicBoolean(false)
    private val liveActivities = AtomicInteger(0)

    fun install(application: Application) {
        if (installed.compareAndSet(false, true)) application.registerActivityLifecycleCallbacks(this)
    }

    fun hasLiveActivity(): Boolean = liveActivities.get() > 0

    override fun onActivityCreated(activity: Activity, savedInstanceState: android.os.Bundle?) = liveActivities.incrementAndGet().let { }
    override fun onActivityStarted(activity: Activity) = Unit
    override fun onActivityResumed(activity: Activity) = Unit
    override fun onActivityPaused(activity: Activity) = Unit
    override fun onActivityStopped(activity: Activity) = Unit
    override fun onActivitySaveInstanceState(activity: Activity, outState: android.os.Bundle) = Unit
    override fun onActivityDestroyed(activity: Activity) = liveActivities.updateAndGet { count -> (count - 1).coerceAtLeast(0) }.let { }
}

package app.hanni.mvp.android.installer

import android.app.Activity
import android.app.Application
import java.util.concurrent.atomic.AtomicBoolean
import java.util.Collections
import java.util.IdentityHashMap

/** The periodic worker must only mutate an application that is actually closed. */
internal object UpdateActivityGuard : Application.ActivityLifecycleCallbacks {
    private val installed = AtomicBoolean(false)
    private val activities = Collections.newSetFromMap(IdentityHashMap<Activity, Boolean>())

    fun install(application: Application, current: Activity? = null) {
        synchronized(activities) { if (current != null) activities.add(current) }
        if (installed.compareAndSet(false, true)) application.registerActivityLifecycleCallbacks(this)
    }

    fun hasLiveActivity(): Boolean = synchronized(activities) { activities.isNotEmpty() }

    override fun onActivityCreated(activity: Activity, savedInstanceState: android.os.Bundle?) { synchronized(activities) { activities.add(activity) } }
    override fun onActivityStarted(activity: Activity) = Unit
    override fun onActivityResumed(activity: Activity) = Unit
    override fun onActivityPaused(activity: Activity) = Unit
    override fun onActivityStopped(activity: Activity) = Unit
    override fun onActivitySaveInstanceState(activity: Activity, outState: android.os.Bundle) = Unit
    override fun onActivityDestroyed(activity: Activity) { synchronized(activities) { activities.remove(activity) } }
}

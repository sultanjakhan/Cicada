# No reflection-based keep rules are needed: Tauri's @TauriPlugin processor
# emits the command bridge for AndroidInstallerPlugin.
# JNI and WorkManager entry points are discovered by Android/runtime metadata.
-keep class app.hanni.mvp.android.installer.ContentSyncNative { *; }
-keep class app.hanni.mvp.android.installer.HanniContentSyncWorker { *; }
-keep class app.hanni.mvp.android.installer.SleepNative { *; }
-keep class app.hanni.mvp.android.installer.HanniSleepWorker { *; }

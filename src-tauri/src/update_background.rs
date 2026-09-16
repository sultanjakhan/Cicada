//! Windowless, per-user Windows updater entry point.
use tauri::{AppHandle, Manager};

pub(crate) async fn run(app: AppHandle) -> Result<i32, String> {
    #[cfg(not(windows))]
    { let _ = app; return Ok(0); }
    #[cfg(windows)]
    {
        // setup holds this file lock for every instance using the same profile.
        // Reaching here proves no interactive instance can be interrupted.
        let state = app.state::<crate::app_updates::UpdateState>();
        let status = crate::app_updates::mvp_update_check(app.clone(), state).await?;
        if status.phase == "available" {
            let state = app.state::<crate::app_updates::UpdateState>();
            crate::app_updates::mvp_update_prepare(app.clone(), state).await?;
            let state = app.state::<crate::app_updates::UpdateState>();
            crate::app_updates::mvp_update_install(app, state, status.version.unwrap_or_default()).await?;
        }
        Ok(0)
    }
}

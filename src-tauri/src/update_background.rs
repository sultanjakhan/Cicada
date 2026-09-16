//! Windowless, per-user Windows updater entry point.
use tauri::{AppHandle, Manager};

pub(crate) async fn run(app: AppHandle) -> Result<i32, String> {
    #[cfg(not(windows))]
    {
        let _ = app;
        return Ok(0);
    }
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
            crate::app_updates::install_update(
                app.clone(),
                state,
                status.version.unwrap_or_default(),
                true,
            )
            .await?;
        }
        Ok(0)
    }
}

#[cfg(all(test, windows))]
mod tests {
    #[test]
    fn running_profile_excludes_updater_but_other_profiles_remain_independent() {
        let profile = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let interactive = crate::acquire_instance_lock(profile.path()).unwrap();
        assert!(crate::acquire_instance_lock(profile.path()).is_err());
        assert!(crate::acquire_instance_lock(other.path()).is_ok());
        drop(interactive);
        assert!(crate::acquire_instance_lock(profile.path()).is_ok());
    }
}

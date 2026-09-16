//! Windowless, per-user Windows updater entry point.
use tauri::{AppHandle, Manager};

#[cfg(windows)]
pub(crate) fn enroll_logon_task(scheduler: &std::path::Path, executable: &std::path::Path) -> bool {
    use std::os::windows::process::CommandExt;
    let result = (|| -> Option<()> {
        let user = std::process::Command::new(scheduler.with_file_name("whoami.exe"))
            .args(["/user", "/fo", "csv", "/nh"])
            .creation_flags(0x08000000)
            .output()
            .ok()?;
        if !user.status.success() {
            return None;
        }
        let output = String::from_utf8_lossy(&user.stdout);
        let sid = output.trim().rsplit(',').next()?.trim_matches('"');
        if !sid.starts_with("S-1-5-")
            || !sid
                .bytes()
                .all(|c| c.is_ascii_digit() || c == b'-' || c == b'S')
        {
            return None;
        }
        let xml = logon_task_xml(&executable.to_string_lossy(), sid);
        let file = write_task_xml(&xml).ok()?;
        let created = std::process::Command::new(scheduler)
            .args(["/Create", "/TN", "Hanni MVP automatic updates", "/XML"])
            .arg(file.as_os_str())
            .arg("/F")
            .creation_flags(0x08000000)
            .output()
            .ok()?;
        created.status.success().then_some(())
    })();
    result.is_some()
}

#[cfg(windows)]
fn write_task_xml(xml: &str) -> std::io::Result<tempfile::TempPath> {
    use std::io::Write;
    // schtasks requests exclusive file access. Close the writing handle before
    // invoking it, keeping the path guard alive for automatic cleanup.
    let bytes: Vec<u8> = std::iter::once(0xfeffu16)
        .chain(xml.encode_utf16())
        .flat_map(u16::to_le_bytes)
        .collect();
    let mut file = tempfile::NamedTempFile::new()?;
    file.write_all(&bytes)?;
    file.as_file().sync_all()?;
    Ok(file.into_temp_path())
}

#[cfg(windows)]
fn logon_task_xml(executable: &str, sid: &str) -> String {
    let executable = executable
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?><Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers><LogonTrigger><Enabled>true</Enabled><UserId>{sid}</UserId></LogonTrigger></Triggers><Principals><Principal id="Author"><UserId>{sid}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><Enabled>true</Enabled><Hidden>true</Hidden><ExecutionTimeLimit>PT15M</ExecutionTimeLimit></Settings><Actions Context="Author"><Exec><Command>{executable}</Command><Arguments>--update-background</Arguments></Exec></Actions></Task>"#
    )
}

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
    fn task_xml_allows_the_schedulers_exclusive_reader() {
        use std::os::windows::fs::OpenOptionsExt;
        let path = super::write_task_xml("<Task />").unwrap();
        let reader = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&path);
        assert!(reader.is_ok());
        drop(reader);
        let bytes = std::fs::read(&path).unwrap();
        assert!(bytes.starts_with(&[0xff, 0xfe]));
    }
    #[test]
    fn logon_registration_scopes_trigger_to_current_user_and_preserves_unicode_paths() {
        let xml =
            super::logon_task_xml(r"C:\Example\Кириллица & test\hanni-mvp.exe", "S-1-5-21-123");
        assert_eq!(xml.matches("<UserId>S-1-5-21-123</UserId>").count(), 2);
        assert!(xml.contains("Кириллица &amp; test"));
        assert!(xml.contains("<LogonType>InteractiveToken</LogonType>"));
        assert!(xml.contains("<RunLevel>LeastPrivilege</RunLevel>"));
    }
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

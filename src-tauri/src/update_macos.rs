//! User-scoped scheduling for the installed macOS bundle, never a DEV copy.
use std::{
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    process::Command,
};
use tauri::{AppHandle, Manager};

const LABEL: &str = "app.hanni.mvp.updates";

fn bundle_in(home: &Path) -> PathBuf {
    home.join("Applications/Hanni MVP.app")
}

fn writable_bundle(home: &Path, executable: &Path) -> bool {
    let bundle = bundle_in(home);
    if executable != bundle.join("Contents/MacOS/hanni-mvp")
        || executable.canonicalize().ok().as_deref() != Some(executable)
    {
        return false;
    }
    let Ok(owner) = home.metadata().map(|m| m.uid()) else {
        return false;
    };
    [bundle.as_path(), bundle.parent().unwrap()]
        .iter()
        .all(|path| {
            path.metadata()
                .is_ok_and(|m| m.is_dir() && m.uid() == owner && m.mode() & 0o300 == 0o300)
        })
}

pub(crate) fn installed_bundle(app: &AppHandle) -> Result<PathBuf, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|_| "Не удалось проверить папку приложения.")?;
    let executable = std::env::current_exe().map_err(|_| "Не удалось проверить приложение.")?;
    let standard = app
        .path()
        .app_data_dir()
        .map_err(|_| "Не удалось проверить профиль.")?;
    if cfg!(debug_assertions)
        || crate::app_data_dir(app)? != standard
        || !writable_bundle(&home, &executable)
    {
        return Err("Обновления Mac доступны для установленной Hanni MVP в ~/Applications. DEV и отдельные копии не обновляются.".into());
    }
    Ok(bundle_in(&home))
}

fn launch_agent(executable: &Path) -> String {
    let executable = executable
        .to_string_lossy()
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>{LABEL}</string>
<key>ProgramArguments</key><array><string>{executable}</string><string>--update-background</string></array>
<key>RunAtLoad</key><true/>
<key>StartInterval</key><integer>21600</integer>
<key>ProcessType</key><string>Background</string>
<key>LowPriorityIO</key><true/>
<key>Nice</key><integer>10</integer>
</dict></plist>
"#
    )
}

pub(crate) fn enroll(app: &AppHandle) -> Result<(), String> {
    let bundle = installed_bundle(app)?;
    let home = app
        .path()
        .home_dir()
        .map_err(|_| "Не удалось настроить фоновые проверки Mac.")?;
    let uid = home
        .metadata()
        .map_err(|_| "Не удалось проверить пользователя Mac.")?
        .uid();
    let domain = format!("gui/{uid}");
    let path = home
        .join("Library/LaunchAgents")
        .join(format!("{LABEL}.plist"));
    let contents = launch_agent(&bundle.join("Contents/MacOS/hanni-mvp"));
    if path.exists() {
        if std::fs::read(&path).ok().as_deref() != Some(contents.as_bytes()) {
            return Err(
                "Настройки фонового обновления Mac отличаются. Проверь LaunchAgent Hanni MVP."
                    .into(),
            );
        }
    } else {
        crate::update_journal::atomic_write(&path, contents.as_bytes())?;
    }
    let loaded = Command::new("/bin/launchctl")
        .args(["print", &format!("{domain}/{LABEL}")])
        .output()
        .is_ok_and(|r| r.status.success());
    if loaded
        || Command::new("/bin/launchctl")
            .arg("bootstrap")
            .arg(domain)
            .arg(path)
            .output()
            .is_ok_and(|r| r.status.success())
    {
        Ok(())
    } else {
        Err("macOS не разрешила включить проверки при закрытом приложении.".into())
    }
}

pub(crate) fn record_result(
    app: &AppHandle,
    outcome: &str,
    version: Option<&str>,
) -> Result<(), String> {
    let path = app
        .path()
        .app_cache_dir()
        .map_err(|_| "Не удалось сохранить результат обновления.")?
        .join("updates/background.json");
    let receipt = serde_json::json!({
        "checked_at": chrono::Utc::now().to_rfc3339(),
        "running_version": app.package_info().version.to_string(),
        "outcome": outcome, "offered_version": version,
    });
    crate::update_journal::atomic_write(
        &path,
        &serde_json::to_vec(&receipt).map_err(|_| "Не удалось сохранить результат обновления.")?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};

    #[test]
    fn final_exit_releases_the_profile_for_the_restarted_application() {
        let profile = tempfile::tempdir().unwrap();
        let lock = crate::acquire_instance_lock(profile.path()).unwrap();
        assert!(crate::acquire_instance_lock(profile.path()).is_err());
        lock.0.unlock().unwrap();
        assert!(crate::acquire_instance_lock(profile.path()).is_ok());
    }

    #[test]
    fn only_the_owned_writable_standard_bundle_can_update() {
        let home = tempfile::tempdir().unwrap();
        let bundle = bundle_in(home.path());
        let executable = bundle.join("Contents/MacOS/hanni-mvp");
        std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
        std::fs::write(&executable, b"synthetic").unwrap();
        let home = home.path().canonicalize().unwrap();
        let executable = executable.canonicalize().unwrap();
        assert!(writable_bundle(&home, &executable));
        assert!(!writable_bundle(
            &home,
            &home.join("Downloads/Hanni MVP.app/Contents/MacOS/hanni-mvp")
        ));
        std::fs::set_permissions(&bundle, std::fs::Permissions::from_mode(0o500)).unwrap();
        assert!(!writable_bundle(&home, &executable));
        std::fs::set_permissions(&bundle, std::fs::Permissions::from_mode(0o700)).unwrap();
        let real = executable.with_extension("real");
        std::fs::rename(&executable, &real).unwrap();
        symlink(&real, &executable).unwrap();
        assert!(!writable_bundle(&home, &executable));
    }

    #[test]
    fn launch_agent_runs_windowless_every_six_hours_without_a_shell() {
        let xml = launch_agent(Path::new(
            "/Users/Example & Test/Applications/Hanni MVP.app/Contents/MacOS/hanni-mvp",
        ));
        let mut child = Command::new("/usr/bin/plutil")
            .args(["-convert", "json", "-o", "-", "-"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        use std::io::Write;
        child
            .stdin
            .take()
            .unwrap()
            .write_all(xml.as_bytes())
            .unwrap();
        let result = child.wait_with_output().unwrap();
        assert!(result.status.success());
        let value: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
        assert_eq!(value["StartInterval"], 21600);
        assert_eq!(value["RunAtLoad"], true);
        assert_eq!(value["ProgramArguments"][1], "--update-background");
        assert_eq!(value["ProgramArguments"].as_array().unwrap().len(), 2);
        assert!(value["ProgramArguments"][0]
            .as_str()
            .unwrap()
            .contains("Example & Test"));
        assert!(value.get("KeepAlive").is_none());
    }
}

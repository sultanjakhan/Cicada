//! User-scoped scheduling for the installed macOS bundle, never a DEV copy.
use std::{
    os::unix::fs::symlink,
    os::unix::fs::MetadataExt,
    os::unix::process::CommandExt,
    path::{Path, PathBuf},
    process::Command,
};
use tauri::{AppHandle, Manager};

const LABEL: &str = "app.hanni.mvp.updates";
const EXECUTABLE: &str = "Contents/MacOS/hanni-mvp";

fn bundle_in(home: &Path) -> PathBuf {
    home.join("Applications/Cicada.app")
}

fn legacy_bundle_in(home: &Path) -> PathBuf {
    home.join("Applications/Hanni MVP.app")
}

fn writable_bundle(home: &Path, bundle: &Path, executable: &Path) -> bool {
    if executable != bundle.join(EXECUTABLE)
        || executable.canonicalize().ok().as_deref() != Some(executable)
    {
        return false;
    }
    let Ok(owner) = home.metadata().map(|m| m.uid()) else {
        return false;
    };
    [bundle, bundle.parent().unwrap()].iter().all(|path| {
        path.metadata()
            .is_ok_and(|m| m.is_dir() && m.uid() == owner && m.mode() & 0o300 == 0o300)
    })
}

fn relocate_legacy_bundle(home: &Path, executable: &Path) -> Result<Option<PathBuf>, String> {
    let legacy = legacy_bundle_in(home);
    if executable != legacy.join(EXECUTABLE) {
        return Ok(None);
    }
    let current = bundle_in(home);
    if legacy
        .symlink_metadata()
        .is_ok_and(|m| m.file_type().is_symlink())
    {
        if legacy.canonicalize().ok().as_deref() == Some(current.as_path()) {
            return Ok(Some(current.join(EXECUTABLE)));
        }
        return Err("Legacy application alias has changed.".into());
    }
    if !writable_bundle(home, &legacy, executable) {
        return Ok(None);
    }
    if current.symlink_metadata().is_ok() {
        return Err("Cicada.app already exists; the installed application was not moved.".into());
    }
    std::fs::rename(&legacy, &current).map_err(|e| e.to_string())?;
    if let Err(error) = symlink("Cicada.app", &legacy) {
        let _ = std::fs::rename(&current, &legacy);
        return Err(error.to_string());
    }
    // The already loaded LaunchAgent still invokes the old path until login.
    // Hide this alias in Finder; the next enrolment writes the new path to disk.
    let hidden = Command::new("/usr/bin/chflags")
        .arg("-h")
        .arg("hidden")
        .arg(&legacy)
        .status()
        .is_ok_and(|status| status.success());
    if !hidden {
        let _ = std::fs::remove_file(&legacy);
        let _ = std::fs::rename(&current, &legacy);
        return Err("Could not hide the legacy LaunchAgent alias.".into());
    }
    Ok(Some(current.join(EXECUTABLE)))
}

pub(crate) fn relaunch_from_legacy_bundle() {
    if cfg!(debug_assertions) {
        return;
    }
    let (Some(home), Ok(executable)) = (std::env::var_os("HOME"), std::env::current_exe()) else {
        return;
    };
    let Ok(home) = PathBuf::from(home).canonicalize() else {
        return;
    };
    let Ok(Some(replacement)) = relocate_legacy_bundle(&home, &executable) else {
        return;
    };
    let error = Command::new(&replacement)
        .args(std::env::args_os().skip(1))
        .exec();
    eprintln!("Cicada could not relaunch from its new bundle: {error}");
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
        || !writable_bundle(&home, &bundle_in(&home), &executable)
    {
        return Err("Обновления Mac доступны для установленной Cicada в ~/Applications. DEV и отдельные копии не обновляются.".into());
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
    let contents = launch_agent(&bundle.join(EXECUTABLE));
    if path.exists() {
        let old = launch_agent(&legacy_bundle_in(&home).join(EXECUTABLE));
        let existing = std::fs::read(&path).ok();
        if existing.as_deref() == Some(old.as_bytes()) {
            crate::update_journal::atomic_write(&path, contents.as_bytes())?;
        } else if existing.as_deref() != Some(contents.as_bytes()) {
            return Err(
                "Настройки фонового обновления Mac отличаются. Проверь LaunchAgent Cicada.".into(),
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
        let temporary_home = tempfile::tempdir().unwrap();
        let home = temporary_home.path().canonicalize().unwrap();
        let bundle = bundle_in(&home);
        let executable = bundle.join(EXECUTABLE);
        std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
        std::fs::write(&executable, b"synthetic").unwrap();
        let executable = executable.canonicalize().unwrap();
        assert!(writable_bundle(&home, &bundle, &executable));
        assert!(!writable_bundle(
            &home,
            &bundle,
            &home.join("Downloads/Cicada.app/Contents/MacOS/hanni-mvp")
        ));
        std::fs::set_permissions(&bundle, std::fs::Permissions::from_mode(0o500)).unwrap();
        assert!(!writable_bundle(&home, &bundle, &executable));
        std::fs::set_permissions(&bundle, std::fs::Permissions::from_mode(0o700)).unwrap();
        let real = executable.with_extension("real");
        std::fs::rename(&executable, &real).unwrap();
        symlink(&real, &executable).unwrap();
        assert!(!writable_bundle(&home, &bundle, &executable));
    }

    #[test]
    fn installed_legacy_bundle_moves_without_replacing_an_existing_cicada() {
        let home = tempfile::tempdir().unwrap();
        let home = home.path().canonicalize().unwrap();
        let legacy = legacy_bundle_in(&home);
        let executable = legacy.join(EXECUTABLE);
        std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
        std::fs::write(&executable, b"signed bridge fixture").unwrap();
        let destination = bundle_in(&home);
        let collision = destination.clone();
        std::fs::write(&collision, b"another application").unwrap();
        assert!(relocate_legacy_bundle(&home, &executable).is_err());
        assert_eq!(std::fs::read(&collision).unwrap(), b"another application");
        std::fs::remove_file(&collision).unwrap();
        symlink("missing-app", &collision).unwrap();
        assert!(relocate_legacy_bundle(&home, &executable).is_err());
        assert!(collision
            .symlink_metadata()
            .unwrap()
            .file_type()
            .is_symlink());
        std::fs::remove_file(&collision).unwrap();
        assert_eq!(
            relocate_legacy_bundle(&home, &home.join("Downloads/hanni-mvp")).unwrap(),
            None
        );
        let relocated = relocate_legacy_bundle(&home, &executable).unwrap().unwrap();
        assert_eq!(relocated, destination.join(EXECUTABLE));
        assert_eq!(std::fs::read(&relocated).unwrap(), b"signed bridge fixture");
        assert_eq!(legacy.canonicalize().unwrap(), destination);
        assert_eq!(
            relocate_legacy_bundle(&home, &executable).unwrap(),
            Some(relocated)
        );
    }

    #[test]
    fn launch_agent_runs_windowless_every_six_hours_without_a_shell() {
        let xml = launch_agent(Path::new(
            "/Users/Example & Test/Applications/Cicada.app/Contents/MacOS/hanni-mvp",
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

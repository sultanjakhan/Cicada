//! User-scoped scheduling for the installed macOS bundle, never a DEV copy.
use std::{
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

fn project_bundle_in(home: &Path) -> PathBuf {
    home.join("Projects/Cicada/application/Cicada.app")
}

// Validate the actual running bundle rather than selecting a folder by name.
#[path = "update_macos_bundle.rs"]
mod bundle_validation;
use bundle_validation::installed_bundle_in;
#[cfg(test)]
use bundle_validation::writable_bundle;

fn relaunch_path(home: &Path, executable: &Path) -> Option<PathBuf> {
    // Pre-Tauri startup is read-only: invalid or unsigned bundles are never
    // moved or re-executed through a legacy alias fallback.
    let bundle = installed_bundle_in(home, executable)?;
    let physical = bundle.join(EXECUTABLE);
    (executable != physical).then_some(physical)
}

pub(crate) fn relaunch_from_installed_alias() {
    if cfg!(debug_assertions) {
        return;
    }
    let (Some(home), Ok(executable)) = (std::env::var_os("HOME"), std::env::current_exe()) else {
        return;
    };
    let Ok(home) = PathBuf::from(home).canonicalize() else {
        return;
    };
    // Tauri caches the starting executable before main and rejects Mac symlink
    // ancestors during restart. Exec the verified physical bundle first.
    let Some(replacement) = relaunch_path(&home, &executable) else {
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
    if !crate::is_production_profile(app)? {
        return Err("Обновления Mac доступны для подписанной Cicada в доступной для записи папке. DEV и отдельные профили не обновляются.".into());
    }
    installed_bundle_in(&home, &executable).ok_or_else(|| {
        "Обновления Mac доступны для подписанной Cicada в доступной для записи папке. DEV и отдельные профили не обновляются.".into()
    })
}

pub(crate) use bundle_validation::InstallTarget;

pub(crate) fn capture_install_target(app: &AppHandle) -> Result<InstallTarget, String> {
    installed_bundle(app)?;
    let home = app
        .path()
        .home_dir()
        .map_err(|_| "Не удалось проверить папку приложения.")?;
    let executable = std::env::current_exe().map_err(|_| "Не удалось проверить приложение.")?;
    bundle_validation::capture_install_target(&home, &executable)
        .ok_or_else(|| "Путь приложения изменился. Повтори проверку обновления.".into())
}

pub(crate) fn revalidate_install_target(
    app: &AppHandle,
    target: &InstallTarget,
) -> Result<(), String> {
    installed_bundle(app)?;
    let home = app
        .path()
        .home_dir()
        .map_err(|_| "Не удалось проверить папку приложения.")?;
    let executable = std::env::current_exe().map_err(|_| "Не удалось проверить приложение.")?;
    if bundle_validation::revalidate_install_target(target, &home, &executable) {
        Ok(())
    } else {
        Err("Путь приложения изменился. Установка отменена.".into())
    }
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

fn known_launch_agent(contents: &[u8], home: &Path) -> bool {
    let canonical_home = home.canonicalize().unwrap_or_else(|_| home.to_path_buf());
    [
        legacy_bundle_in(home),
        bundle_in(home),
        project_bundle_in(home),
        legacy_bundle_in(&canonical_home),
        bundle_in(&canonical_home),
        project_bundle_in(&canonical_home),
    ]
    .iter()
    .any(|bundle| contents == launch_agent(&bundle.join(EXECUTABLE)).as_bytes())
        || generated_launch_agent(contents)
}

fn generated_launch_agent(contents: &[u8]) -> bool {
    if contents.len() > 64 * 1024 {
        return false;
    }
    let Ok(mut child) = Command::new("/usr/bin/plutil")
        .args(["-extract", "ProgramArguments.0", "raw", "-o", "-", "-"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
    else {
        return false;
    };
    use std::io::Write;
    if child
        .stdin
        .take()
        .is_none_or(|mut input| input.write_all(contents).is_err())
    {
        let _ = child.kill();
        let _ = child.wait();
        return false;
    }
    let Ok(output) = child.wait_with_output() else {
        return false;
    };
    if !output.status.success() {
        return false;
    }
    let Ok(raw) = String::from_utf8(output.stdout) else {
        return false;
    };
    let executable = Path::new(raw.trim_end_matches('\n'));
    // Old target is only a migration receipt. It is never launched. Match the
    // whole generated document so custom jobs, extra arguments and shells stay intact.
    bundle_validation::bundle_path(executable).is_some()
        && contents == launch_agent(executable).as_bytes()
}

fn read_launch_agent(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match path.symlink_metadata() {
        Ok(metadata) if metadata.file_type().is_file() => std::fs::read(path)
            .map(Some)
            .map_err(|_| "Настройки фонового обновления Mac недоступны.".into()),
        Ok(_) => {
            Err("Настройки фонового обновления Mac отличаются. Проверь LaunchAgent Cicada.".into())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("Настройки фонового обновления Mac недоступны.".into()),
    }
}

fn register_launch_agent(launchctl: &Path, domain: &str, path: &Path, executable: &Path) -> bool {
    let service = format!("{domain}/{LABEL}");
    let state = Command::new(launchctl).args(["print", &service]).output();
    let loaded = state.as_ref().is_ok_and(|output| output.status.success());
    if let Ok(output) = &state {
        let expected = format!("program = {}", executable.display());
        if loaded
            && String::from_utf8_lossy(&output.stdout)
                .lines()
                .any(|line| line.trim() == expected)
        {
            return true;
        }
    }
    // Compare the loaded target every time, not whether the on-disk plist just
    // changed. A failed reload remains retryable on the next enrollment.
    // Enrollment is foreground-only while holding the profile lock.
    if loaded
        && !Command::new(launchctl)
            .args(["bootout", &service])
            .output()
            .is_ok_and(|output| output.status.success())
    {
        return false;
    }
    Command::new(launchctl)
        .arg("bootstrap")
        .arg(domain)
        .arg(path)
        .output()
        .is_ok_and(|output| output.status.success())
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
    if let Some(existing) = read_launch_agent(&path)? {
        if existing.as_slice() != contents.as_bytes() {
            if known_launch_agent(&existing, &home) {
                crate::update_journal::atomic_write(&path, contents.as_bytes())?;
            } else {
                return Err(
                    "Настройки фонового обновления Mac отличаются. Проверь LaunchAgent Cicada."
                        .into(),
                );
            }
        }
    } else {
        crate::update_journal::atomic_write(&path, contents.as_bytes())?;
    }
    if register_launch_agent(
        Path::new("/bin/launchctl"),
        &domain,
        &path,
        &bundle.join(EXECUTABLE),
    ) {
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
        for file in lock.0 {
            file.unlock().unwrap();
        }
        assert!(crate::acquire_instance_lock(profile.path()).is_ok());
    }

    #[test]
    fn only_the_owned_writable_standard_bundle_can_update() {
        let temporary_home = tempfile::tempdir().unwrap();
        let home = temporary_home.path().canonicalize().unwrap();
        let bundle = bundle_in(&home);
        let executable = bundle.join(EXECUTABLE);
        std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
        bundle_validation::write_signed_fixture(&bundle, "app.hanni.mvp");
        let executable = executable.canonicalize().unwrap();
        assert!(writable_bundle(&home, &bundle, &executable));
        assert_eq!(
            installed_bundle_in(&home, &executable),
            Some(bundle.clone())
        );
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
    fn installed_bundle_accepts_the_exact_owned_projects_alias_and_returns_its_physical_path() {
        let temporary_home = tempfile::tempdir().unwrap();
        let home = temporary_home.path().canonicalize().unwrap();
        let bundle = project_bundle_in(&home);
        let executable = bundle.join(EXECUTABLE);
        std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
        bundle_validation::write_signed_fixture(&bundle, "app.hanni.mvp");
        let standard_alias = bundle_in(&home);
        std::fs::create_dir_all(standard_alias.parent().unwrap()).unwrap();
        symlink(&bundle, &standard_alias).unwrap();

        assert_eq!(
            installed_bundle_in(&home, &executable),
            Some(bundle.clone())
        );
        assert_eq!(
            installed_bundle_in(&home, &standard_alias.join(EXECUTABLE)),
            Some(bundle.clone())
        );
        assert_eq!(
            relaunch_path(&home, &standard_alias.join(EXECUTABLE)),
            Some(bundle.join(EXECUTABLE))
        );
        assert_eq!(relaunch_path(&home, &executable), None);
        let legacy_alias = legacy_bundle_in(&home);
        symlink(&standard_alias, &legacy_alias).unwrap();
        assert_eq!(
            relaunch_path(&home, &legacy_alias.join(EXECUTABLE)),
            Some(bundle.join(EXECUTABLE))
        );
    }

    #[test]
    fn installed_bundle_rejects_an_unsigned_alias_target_and_executable_symlink() {
        let temporary_home = tempfile::tempdir().unwrap();
        let home = temporary_home.path().canonicalize().unwrap();
        let foreign = home.join("Downloads/Cicada.app");
        let foreign_executable = foreign.join(EXECUTABLE);
        std::fs::create_dir_all(foreign_executable.parent().unwrap()).unwrap();
        std::fs::write(&foreign_executable, b"synthetic").unwrap();
        let standard_alias = bundle_in(&home);
        std::fs::create_dir_all(standard_alias.parent().unwrap()).unwrap();
        symlink(&foreign, &standard_alias).unwrap();
        assert_eq!(
            installed_bundle_in(&home, &standard_alias.join(EXECUTABLE)),
            None
        );

        std::fs::remove_file(&standard_alias).unwrap();
        let project = project_bundle_in(&home);
        let executable = project.join(EXECUTABLE);
        std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
        let real = executable.with_extension("real");
        std::fs::write(&real, b"synthetic").unwrap();
        symlink(&real, &executable).unwrap();
        symlink(&project, &standard_alias).unwrap();
        assert_eq!(installed_bundle_in(&home, &executable), None);
    }

    #[test]
    fn launch_agent_updates_only_exact_generated_paths() {
        let temporary_home = tempfile::tempdir().unwrap();
        let home = temporary_home.path().canonicalize().unwrap();
        for bundle in [
            legacy_bundle_in(&home),
            bundle_in(&home),
            project_bundle_in(&home),
        ] {
            assert!(known_launch_agent(
                launch_agent(&bundle.join(EXECUTABLE)).as_bytes(),
                &home
            ));
        }
        assert!(known_launch_agent(
            launch_agent(Path::new(
                "/Users/Example/Custom.app/Contents/MacOS/hanni-mvp"
            ))
            .as_bytes(),
            &home
        ));
    }

    #[test]
    fn arbitrary_alias_relaunches_only_the_verified_physical_bundle() {
        let temporary_home = tempfile::tempdir().unwrap();
        let home = temporary_home.path().canonicalize().unwrap();
        let bundle = home.join("Different folder/Renamed app.app");
        bundle_validation::write_signed_fixture(&bundle, "app.hanni.mvp");
        let alias = home.join("Another alias.app");
        symlink(&bundle, &alias).unwrap();
        assert_eq!(
            relaunch_path(&home, &alias.join(EXECUTABLE)),
            Some(bundle.join(EXECUTABLE))
        );
        assert_eq!(relaunch_path(&home, &bundle.join(EXECUTABLE)), None);
        assert!(bundle.exists());
        assert!(alias.symlink_metadata().unwrap().file_type().is_symlink());
    }

    #[test]
    fn validated_legacy_bundle_is_not_moved() {
        let temporary_home = tempfile::tempdir().unwrap();
        let home = temporary_home.path().canonicalize().unwrap();
        let bundle = legacy_bundle_in(&home);
        bundle_validation::write_signed_fixture(&bundle, "app.hanni.mvp");
        assert_eq!(relaunch_path(&home, &bundle.join(EXECUTABLE)), None);
        assert!(bundle.exists());
        assert!(!bundle_in(&home).exists());
    }

    #[test]
    fn loaded_job_matches_actual_executable_and_failed_reload_retries() {
        let fixture = tempfile::tempdir().unwrap();
        let launchctl = fixture.path().join("launchctl");
        let path = fixture.path().join("updates.plist");
        let executable = Path::new("/Users/Example/Any.app/Contents/MacOS/hanni-mvp");
        let script = "#!/bin/sh\necho \"$1\" >> \"$0.calls\"\nif [ \"$1\" = print ]; then cat \"$0.program\"; fi\nif [ \"$1\" = bootout ] && [ -f \"$0.fail\" ]; then exit 1; fi\nexit 0\n";
        std::fs::write(&launchctl, script).unwrap();
        std::fs::set_permissions(&launchctl, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::write(
            launchctl.with_extension("program"),
            format!("program = {}\n", executable.display()),
        )
        .unwrap();
        assert!(register_launch_agent(
            &launchctl, "gui/999", &path, executable
        ));
        assert_eq!(
            std::fs::read_to_string(launchctl.with_extension("calls")).unwrap(),
            "print\n"
        );
        std::fs::remove_file(launchctl.with_extension("calls")).unwrap();
        std::fs::write(
            launchctl.with_extension("program"),
            "program = /old/location\n",
        )
        .unwrap();
        std::fs::write(launchctl.with_extension("fail"), "").unwrap();
        assert!(!register_launch_agent(
            &launchctl, "gui/999", &path, executable
        ));
        assert_eq!(
            std::fs::read_to_string(launchctl.with_extension("calls")).unwrap(),
            "print\nbootout\n"
        );
        std::fs::remove_file(launchctl.with_extension("fail")).unwrap();
        std::fs::remove_file(launchctl.with_extension("calls")).unwrap();
        assert!(register_launch_agent(
            &launchctl, "gui/999", &path, executable
        ));
        assert_eq!(
            std::fs::read_to_string(launchctl.with_extension("calls")).unwrap(),
            "print\nbootout\nbootstrap\n"
        );
    }

    #[test]
    fn invalid_legacy_bundle_and_alias_are_never_moved_or_reexecuted() {
        let fixture = tempfile::tempdir().unwrap();
        let home = fixture.path().canonicalize().unwrap();
        let legacy = legacy_bundle_in(&home);
        std::fs::create_dir_all(legacy.join("Contents/MacOS")).unwrap();
        std::fs::write(legacy.join(EXECUTABLE), "unsigned").unwrap();
        assert_eq!(relaunch_path(&home, &legacy.join(EXECUTABLE)), None);
        assert!(legacy.exists());
        assert!(!bundle_in(&home).exists());
        std::fs::remove_dir_all(&legacy).unwrap();
        let invalid = home.join("Invalid.app");
        std::fs::create_dir_all(invalid.join("Contents/MacOS")).unwrap();
        std::fs::write(invalid.join(EXECUTABLE), "unsigned").unwrap();
        symlink(&invalid, &legacy).unwrap();
        assert_eq!(relaunch_path(&home, &legacy.join(EXECUTABLE)), None);
        assert_eq!(legacy.canonicalize().unwrap(), invalid);
    }

    #[test]
    fn arbitrary_generated_jobs_migrate_but_custom_arguments_and_shells_do_not() {
        let temporary_home = tempfile::tempdir().unwrap();
        let home = temporary_home.path().canonicalize().unwrap();
        let job = launch_agent(&home.join("Any folder & space/Renamed.app").join(EXECUTABLE));
        assert!(known_launch_agent(job.as_bytes(), &home));
        // The old bundle may no longer exist after the owner moved it.
        assert!(!known_launch_agent(
            job.replace("--update-background", "--background")
                .as_bytes(),
            &home
        ));
        assert!(!known_launch_agent(
            job.replace(
                "<key>RunAtLoad</key><true/>",
                "<key>RunAtLoad</key><false/>"
            )
            .as_bytes(),
            &home
        ));
        assert!(!known_launch_agent(
            launch_agent(Path::new("/bin/sh")).as_bytes(),
            &home
        ));
        assert!(!known_launch_agent(b"malformed plist", &home));
    }

    #[test]
    fn launch_agent_reader_refuses_symlinks_and_preserves_custom_contents() {
        let temporary_home = tempfile::tempdir().unwrap();
        let home = temporary_home.path().canonicalize().unwrap();
        let path = home.join("LaunchAgents/app.hanni.mvp.updates.plist");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"custom user configuration").unwrap();
        assert_eq!(
            read_launch_agent(&path).unwrap(),
            Some(b"custom user configuration".to_vec())
        );
        assert!(!known_launch_agent(
            &read_launch_agent(&path).unwrap().unwrap(),
            &home
        ));
        std::fs::remove_file(&path).unwrap();

        let target = home.join("custom.plist");
        std::fs::write(&target, launch_agent(&bundle_in(&home).join(EXECUTABLE))).unwrap();
        symlink(&target, &path).unwrap();
        assert!(read_launch_agent(&path).is_err());
        assert_eq!(
            std::fs::read(&target).unwrap(),
            launch_agent(&bundle_in(&home).join(EXECUTABLE)).as_bytes()
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

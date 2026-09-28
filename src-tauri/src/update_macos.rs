//! User-scoped scheduling for the installed macOS bundle, never a DEV copy.
use sha2::{Digest, Sha256};
use std::{
    ffi::OsStr,
    io::Read,
    os::unix::fs::symlink,
    os::unix::fs::MetadataExt,
    os::unix::process::CommandExt,
    path::{Path, PathBuf},
    process::{Command, Output},
};
use tauri::{AppHandle, Manager};

const LABEL: &str = "app.hanni.mvp.updates";
const EXECUTABLE: &str = "Contents/MacOS/hanni-mvp";
const BACKGROUND_UNAVAILABLE: &str = "macOS не запустила фоновое обновление Cicada. Проверка обновлений внутри приложения остаётся доступна.";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AgentState {
    Missing,
    Running,
    Idle,
    Pending,
    Failed,
    Unknown,
}

fn agent_state(output: &Output) -> AgentState {
    if !output.status.success() {
        return if output.status.code() == Some(113)
            && String::from_utf8_lossy(&output.stderr).contains("Could not find service")
        {
            AgentState::Missing
        } else {
            AgentState::Unknown
        };
    }
    let text = String::from_utf8_lossy(&output.stdout);
    // launchctl's diagnostic format is not an API. Only accept known root fields;
    // an unfamiliar format must never authorize removing a possibly running job.
    let field = |name: &str| {
        text.lines().find_map(|line| {
            let line = line.strip_prefix('\t')?;
            let (key, value) = line.split_once(" = ")?;
            (key == name).then_some(value)
        })
    };
    let pid = field("pid").and_then(|value| value.parse::<u32>().ok());
    if field("state") == Some("running") && pid.is_some_and(|pid| pid > 0) {
        return AgentState::Running;
    }
    if field("state") != Some("not running")
        || field("pid").is_some()
        || field("active count").is_some_and(|count| count != "0")
    {
        return AgentState::Unknown;
    }
    if field("job state") == Some("spawn failed")
        || field("last exit reason") == Some("OS_REASON_CODESIGNING")
        || field("last exit code").is_some_and(|code| code != "0")
    {
        AgentState::Failed
    } else if field("last exit code") == Some("0") {
        AgentState::Idle
    } else {
        AgentState::Pending
    }
}

fn executable_fingerprint(path: &Path) -> Result<String, String> {
    let mut file = std::fs::File::open(path)
        .map_err(|_| "Не удалось проверить сборку для фоновых обновлений.")?;
    let mut digest = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|_| "Не удалось проверить сборку для фоновых обновлений.")?;
        if count == 0 {
            return Ok(hex::encode(digest.finalize()));
        }
        digest.update(&buffer[..count]);
    }
}

fn reconcile_agent(
    path: &Path,
    domain: &str,
    receipt: &Path,
    fingerprint: &str,
    run: &mut impl FnMut(&[&OsStr]) -> Result<Output, String>,
) -> Result<bool, String> {
    let service = format!("{domain}/{LABEL}");
    let state = agent_state(&run(&[OsStr::new("print"), OsStr::new(&service)])?);
    if state == AgentState::Unknown {
        return Err("Не удалось проверить состояние фонового обновления Mac.".into());
    }
    let receipt_error = "Не удалось прочитать регистрацию фонового обновления Mac.";
    let previous = match std::fs::metadata(receipt) {
        Ok(metadata) if metadata.len() == 64 => {
            let value = std::fs::read_to_string(receipt).map_err(|_| receipt_error)?;
            if !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err(receipt_error.into());
            }
            Some(value)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        _ => return Err(receipt_error.into()),
    };
    if previous.as_deref() == Some(fingerprint) {
        return if matches!(state, AgentState::Running | AgentState::Idle) {
            Ok(false)
        } else {
            Err(BACKGROUND_UNAVAILABLE.into())
        };
    }
    if state == AgentState::Running {
        return Err("Фоновое обновление ещё работает. Его регистрация обновится при следующем запуске Cicada.".into());
    }
    // Persist before mutation: a failed bootstrap or a process crash must not
    // cause an endless registration/relaunch loop for this same signed binary.
    crate::update_journal::atomic_write(receipt, fingerprint.as_bytes())?;
    if state != AgentState::Missing
        && !run(&[OsStr::new("bootout"), OsStr::new(&service)])?
            .status
            .success()
    {
        return Err("Не удалось обновить регистрацию фонового обновления Mac.".into());
    }
    if !run(&[
        OsStr::new("bootstrap"),
        OsStr::new(domain),
        path.as_os_str(),
    ])?
    .status
    .success()
    {
        return Err(BACKGROUND_UNAVAILABLE.into());
    }
    Ok(true)
}

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
    let receipt = app
        .path()
        .app_cache_dir()
        .map_err(|_| "Не удалось сохранить регистрацию фонового обновления Mac.")?
        .join("updates/macos-enrollment.sha256");
    let fingerprint = executable_fingerprint(&bundle.join(EXECUTABLE))?;
    let mut run = |args: &[&OsStr]| {
        Command::new("/bin/launchctl")
            .args(args)
            .output()
            .map_err(|_| "Не удалось проверить фоновое обновление Mac.".to_string())
    };
    if reconcile_agent(&path, &domain, &receipt, &fingerprint, &mut run)? {
        // bootstrap succeeds before launchd tries to execute the binary. Check
        // the asynchronous result instead of treating registration as a launch.
        std::thread::sleep(std::time::Duration::from_millis(500));
        let service = format!("{domain}/{LABEL}");
        let result = run(&[OsStr::new("print"), OsStr::new(&service)])?;
        if !matches!(agent_state(&result), AgentState::Running | AgentState::Idle) {
            return Err(BACKGROUND_UNAVAILABLE.into());
        }
    }
    Ok(())
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
    use std::os::unix::process::ExitStatusExt;

    fn output(code: i32, stdout: &str) -> Output {
        Output {
            status: std::process::ExitStatus::from_raw(code << 8),
            stdout: stdout.as_bytes().to_vec(),
            stderr: if code == 113 {
                b"Could not find service".to_vec()
            } else {
                Vec::new()
            },
        }
    }

    fn idle() -> Output {
        output(
            0,
            "\tstate = not running\n\tlast exit code = 0\n\tjob state = exited\n",
        )
    }

    fn denied() -> Output {
        output(0, "\tstate = not running\n\tlast exit reason = OS_REASON_CODESIGNING\n\tjob state = spawn failed\n\tproperties = needs LWCR update | managed LWCR | has LWCR\n")
    }

    #[test]
    fn loaded_job_is_not_proof_of_a_successful_background_launch() {
        assert_eq!(agent_state(&denied()), AgentState::Failed);
        assert_eq!(agent_state(&idle()), AgentState::Idle);
        assert_eq!(agent_state(&output(113, "")), AgentState::Missing);
        assert_eq!(agent_state(&output(1, "")), AgentState::Unknown);
        assert_eq!(
            agent_state(&output(0, "\tstate = not running\n")),
            AgentState::Pending
        );
        assert_eq!(
            agent_state(&output(0, "\tstate = running\n")),
            AgentState::Unknown
        );
        assert_eq!(
            agent_state(&output(0, "\tstate = not running\n\tlast exit code = 1\n")),
            AgentState::Failed
        );
        assert_eq!(agent_state(&output(0, "\tstate = not running\n\tlast exit code = 0\n\tresource coalition = {\n\t\tstate = active\n\t}\n")), AgentState::Idle);
    }

    #[test]
    fn changed_build_registers_once_and_repeated_checks_only_observe() {
        let dir = tempfile::tempdir().unwrap();
        let receipt = dir.path().join("enrollment");
        let plist = dir.path().join("agent.plist");
        let fingerprint = "a".repeat(64);
        let mut calls = Vec::new();
        let mut run = |args: &[&OsStr]| {
            calls.push(
                args.iter()
                    .map(|arg| arg.to_string_lossy().into_owned())
                    .collect::<Vec<_>>(),
            );
            Ok(idle())
        };
        assert!(reconcile_agent(&plist, "gui/501", &receipt, &fingerprint, &mut run).unwrap());
        assert!(!reconcile_agent(&plist, "gui/501", &receipt, &fingerprint, &mut run).unwrap());
        assert_eq!(
            calls
                .iter()
                .map(|args| args[0].as_str())
                .collect::<Vec<_>>(),
            ["print", "bootout", "bootstrap", "print"]
        );
        assert_eq!(calls[1], ["bootout", "gui/501/app.hanni.mvp.updates"]);
        assert_eq!(calls[2][2], plist.to_string_lossy());
        assert_eq!(std::fs::read_to_string(&receipt).unwrap(), fingerprint);
        assert!(
            reconcile_agent(&plist, "gui/501", &receipt, &"b".repeat(64), &mut |_| Ok(
                idle()
            ))
            .unwrap()
        );
    }

    #[test]
    fn persistent_codesigning_failure_does_not_cause_a_registration_loop() {
        let dir = tempfile::tempdir().unwrap();
        let receipt = dir.path().join("enrollment");
        let fingerprint = "a".repeat(64);
        let mut mutations = 0;
        let mut run = |args: &[&OsStr]| {
            if args[0] != OsStr::new("print") {
                mutations += 1;
            }
            Ok(denied())
        };
        assert!(reconcile_agent(
            Path::new("agent.plist"),
            "gui/501",
            &receipt,
            &fingerprint,
            &mut run
        )
        .unwrap());
        assert_eq!(
            reconcile_agent(
                Path::new("agent.plist"),
                "gui/501",
                &receipt,
                &fingerprint,
                &mut run
            ),
            Err(BACKGROUND_UNAVAILABLE.into())
        );
        assert_eq!(mutations, 2);
    }

    #[test]
    fn failed_bootstrap_is_recorded_before_retry_and_missing_jobs_are_not_removed() {
        let dir = tempfile::tempdir().unwrap();
        let receipt = dir.path().join("enrollment");
        let fingerprint = "a".repeat(64);
        let mut calls = Vec::new();
        let mut run = |args: &[&OsStr]| {
            calls.push(args[0].to_string_lossy().into_owned());
            if args[0] == OsStr::new("print") {
                Ok(output(113, ""))
            } else {
                assert_eq!(std::fs::read_to_string(&receipt).unwrap(), fingerprint);
                Ok(output(1, ""))
            }
        };
        for _ in 0..2 {
            assert!(reconcile_agent(
                Path::new("agent.plist"),
                "gui/501",
                &receipt,
                &fingerprint,
                &mut run
            )
            .is_err());
        }
        assert_eq!(calls, ["print", "bootstrap", "print"]);
    }

    #[test]
    fn active_or_unrecognized_job_is_never_removed_for_a_new_build() {
        for status in [
            "\tstate = running\n\tpid = 123\n",
            "\tstate = unknown\n",
            "\tstate = not running\n\tpid = 123\n",
            "\tstate = not running\n\tactive count = 1\n",
        ] {
            let dir = tempfile::tempdir().unwrap();
            let receipt = dir.path().join("enrollment");
            let mut calls = 0;
            let result = reconcile_agent(
                Path::new("agent.plist"),
                "gui/501",
                &receipt,
                &"a".repeat(64),
                &mut |args| {
                    calls += 1;
                    assert_eq!(args[0], OsStr::new("print"));
                    Ok(output(0, status))
                },
            );
            assert!(result.is_err());
            assert_eq!(calls, 1);
            assert!(!receipt.exists());
        }
    }

    #[test]
    fn fingerprint_changes_when_the_same_version_binary_is_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let binary = dir.path().join("app");
        std::fs::write(&binary, b"first signed executable").unwrap();
        let first = executable_fingerprint(&binary).unwrap();
        assert_eq!(first.len(), 64);
        std::fs::write(&binary, b"second signed executable").unwrap();
        assert_ne!(first, executable_fingerprint(&binary).unwrap());
    }

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

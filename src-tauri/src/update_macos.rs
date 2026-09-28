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
const UPDATE_ARCHIVE_INVALID: &str = "Пакет обновления Mac повреждён или имеет неподдерживаемую структуру. Установленная Cicada сохранена.";
const UPDATE_SIGNER_REQUIRED: &str = "Обновление остановлено: не удалось подтвердить постоянную подпись Apple у установленной Cicada. Текущая версия и подключения сохранены.";
const UPDATE_SIGNER_CHANGED: &str = "Обновление остановлено: подпись новой Cicada не соответствует установленной. Текущая версия и подключения сохранены.";
const MAX_EXPANDED_UPDATE: u64 = 512 * 1024 * 1024;
const MAX_UPDATE_ENTRIES: usize = 20_000;

struct BundleSignature {
    code: security_framework::os::macos::code_signing::SecStaticCode,
    requirement: security_framework::os::macos::code_signing::SecRequirement,
    identity: BundleIdentity,
}

#[derive(Clone)]
struct BundleIdentity {
    requirement_data: Vec<u8>,
    team: String,
    version: String,
}

fn bundle_signature(bundle: &Path) -> Result<BundleSignature, ()> {
    use core_foundation::{
        base::{CFType, CFTypeRef, TCFType},
        data::{CFData, CFDataRef},
        dictionary::{CFDictionary, CFDictionaryRef},
        string::{CFString, CFStringRef},
        url::CFURL,
    };
    use security_framework::os::macos::code_signing::{Flags, SecRequirement, SecStaticCode};
    #[link(name = "Security", kind = "framework")]
    extern "C" {
        fn SecCodeCopySigningInformation(
            code: CFTypeRef,
            flags: u32,
            information: *mut CFDictionaryRef,
        ) -> i32;
        fn SecRequirementCopyData(requirement: CFTypeRef, flags: u32, data: *mut CFDataRef) -> i32;
        static kSecCodeInfoTeamIdentifier: CFStringRef;
        static kSecCodeInfoDesignatedRequirement: CFStringRef;
        static kSecCodeInfoPList: CFStringRef;
    }
    let url = CFURL::from_path(bundle, true).ok_or(())?;
    let code = SecStaticCode::from_path(&url, Flags::NONE).map_err(|_| ())?;
    let apple: SecRequirement = "anchor apple generic and identifier \"app.hanni.mvp\""
        .parse()
        .map_err(|_| ())?;
    code.check_validity(signature_flags(), &apple)
        .map_err(|_| ())?;
    // A matching self-signed DR is insufficient for file-Keychain continuity:
    // its partition can still bind each build to a different cdhash.
    let mut raw_info = std::ptr::null();
    let info: CFDictionary<CFString, CFType> = unsafe {
        // kSecCSSigningInformation | kSecCSRequirementInformation (SecCode.h).
        if SecCodeCopySigningInformation(code.as_CFTypeRef(), (1 << 1) | (1 << 2), &mut raw_info)
            != 0
            || raw_info.is_null()
        {
            return Err(());
        }
        CFDictionary::wrap_under_create_rule(raw_info)
    };
    let team = info
        .find(unsafe { CFString::wrap_under_get_rule(kSecCodeInfoTeamIdentifier) })
        .and_then(|value| value.downcast::<CFString>())
        .map(|value| value.to_string())
        .filter(|value| !value.is_empty())
        .ok_or(())?;
    let requirement = info
        .find(unsafe { CFString::wrap_under_get_rule(kSecCodeInfoDesignatedRequirement) })
        .and_then(|value| value.downcast::<SecRequirement>())
        .ok_or(())?;
    let raw_plist = info
        .find(unsafe { CFString::wrap_under_get_rule(kSecCodeInfoPList) })
        .and_then(|value| value.downcast::<CFDictionary>())
        .ok_or(())?;
    let plist: CFDictionary<CFString, CFType> =
        unsafe { CFDictionary::wrap_under_get_rule(raw_plist.as_concrete_TypeRef()) };
    let field = |key: &str| {
        plist
            .find(CFString::new(key))
            .and_then(|value| value.downcast::<CFString>())
            .map(|value| value.to_string())
    };
    if field("CFBundleIdentifier").as_deref() != Some("app.hanni.mvp")
        || field("CFBundleExecutable").as_deref() != Some("hanni-mvp")
    {
        return Err(());
    }
    let version = field("CFBundleShortVersionString").ok_or(())?;
    let mut raw_requirement = std::ptr::null();
    let requirement_data = unsafe {
        if SecRequirementCopyData(requirement.as_CFTypeRef(), 0, &mut raw_requirement) != 0
            || raw_requirement.is_null()
        {
            return Err(());
        }
        CFData::wrap_under_create_rule(raw_requirement)
            .bytes()
            .to_vec()
    };
    Ok(BundleSignature {
        code,
        requirement,
        identity: BundleIdentity {
            requirement_data,
            team,
            version,
        },
    })
}

fn signature_flags() -> security_framework::os::macos::code_signing::Flags {
    use security_framework::os::macos::code_signing::Flags;
    Flags::STRICT_VALIDATE
        | Flags::CHECK_NESTED_CODE
        | Flags::CHECK_ALL_ARCHITECTURES
        | Flags::NO_NETWORK_ACCESS
}

fn extract_update_archive(bytes: &[u8]) -> Result<tempfile::TempDir, String> {
    use std::{collections::HashSet, path::Component};
    let temporary = tempfile::Builder::new()
        .prefix("cicada-update-verification-")
        .tempdir()
        .map_err(|_| UPDATE_ARCHIVE_INVALID)?;
    let decoder = flate2::read::GzDecoder::new(bytes).take(MAX_EXPANDED_UPDATE);
    let mut archive = tar::Archive::new(decoder);
    let mut paths = HashSet::new();
    let mut expanded = 0u64;
    for entry in archive.entries().map_err(|_| UPDATE_ARCHIVE_INVALID)? {
        let mut entry = entry.map_err(|_| UPDATE_ARCHIVE_INVALID)?;
        let path = entry
            .path()
            .map_err(|_| UPDATE_ARCHIVE_INVALID)?
            .into_owned();
        let parts: Vec<_> = path.components().collect();
        let kind = entry.header().entry_type();
        let size = entry.size();
        expanded = expanded.checked_add(size).ok_or(UPDATE_ARCHIVE_INVALID)?;
        if parts.first() != Some(&Component::Normal(OsStr::new("Cicada.app")))
            || parts
                .iter()
                .any(|part| !matches!(part, Component::Normal(_)))
            || (parts.len() > 1 && parts[1] != Component::Normal(OsStr::new("Contents")))
            || (parts.len() == 1 && !kind.is_dir())
            || !(kind.is_file() || kind.is_dir())
            || (kind.is_dir() && size != 0)
            || entry.header().mode().map_err(|_| UPDATE_ARCHIVE_INVALID)? & 0o7000 != 0
            || expanded > MAX_EXPANDED_UPDATE
            || paths.len() >= MAX_UPDATE_ENTRIES
            || !paths.insert(path)
        {
            return Err(UPDATE_ARCHIVE_INVALID.into());
        }
        // Current Cicada bundles contain only files/directories. Reject links,
        // including in-bundle links, before either this check or Tauri extracts.
        if !entry
            .unpack_in(temporary.path())
            .map_err(|_| UPDATE_ARCHIVE_INVALID)?
        {
            return Err(UPDATE_ARCHIVE_INVALID.into());
        }
    }
    if archive.into_inner().limit() == 0 {
        return Err(UPDATE_ARCHIVE_INVALID.into());
    }
    let bundle = temporary.path().join("Cicada.app");
    if !bundle.join("Contents/Info.plist").is_file()
        || !bundle.join(EXECUTABLE).is_file()
        || bundle
            .join(EXECUTABLE)
            .metadata()
            .map_err(|_| UPDATE_ARCHIVE_INVALID)?
            .mode()
            & 0o111
            == 0
    {
        return Err(UPDATE_ARCHIVE_INVALID.into());
    }
    Ok(temporary)
}

pub(crate) fn verify_update_archive(
    installed: &Path,
    bytes: &[u8],
    expected_version: &str,
) -> Result<(), String> {
    use security_framework::os::macos::code_signing::{Flags, SecCode};
    let current = bundle_signature(installed).map_err(|_| UPDATE_SIGNER_REQUIRED)?;
    // The running app must still be the identity validated at its installed
    // path; an independently replaced on-disk bundle cannot change this trust.
    SecCode::for_self(Flags::NONE)
        .and_then(|code| code.check_validity(Flags::NONE, &current.requirement))
        .map_err(|_| UPDATE_SIGNER_REQUIRED)?;
    let temporary = extract_update_archive(bytes)?;
    let candidate = bundle_signature(&temporary.path().join("Cicada.app"))
        .map_err(|_| UPDATE_SIGNER_CHANGED)?;
    compatible_update_identity(&current.identity, &candidate.identity, expected_version)?;
    candidate
        .code
        .check_validity(signature_flags(), &current.requirement)
        .map_err(|_| UPDATE_SIGNER_CHANGED.into())
}

fn compatible_update_identity(
    current: &BundleIdentity,
    candidate: &BundleIdentity,
    expected_version: &str,
) -> Result<(), String> {
    if candidate.version != expected_version {
        return Err(UPDATE_ARCHIVE_INVALID.into());
    }
    if candidate.team != current.team || candidate.requirement_data != current.requirement_data {
        return Err(UPDATE_SIGNER_CHANGED.into());
    }
    Ok(())
}

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

    #[test]
    fn verified_signatures_must_preserve_team_and_requirement_and_match_the_offered_version() {
        // These are policy fixtures, not evidence of an Apple-signed install.
        let current = BundleIdentity {
            team: "EXAMPLETEAM".into(),
            requirement_data: vec![1, 2, 3],
            version: "0.0.1".into(),
        };
        let candidate = BundleIdentity {
            version: "0.0.2".into(),
            ..current.clone()
        };
        assert!(compatible_update_identity(&current, &candidate, "0.0.2").is_ok());
        let wrong_team = BundleIdentity {
            team: "OTHERTEAM".into(),
            ..candidate.clone()
        };
        let wrong_requirement = BundleIdentity {
            requirement_data: vec![1, 2, 4],
            ..candidate.clone()
        };
        for incompatible in [&wrong_team, &wrong_requirement] {
            assert_eq!(
                compatible_update_identity(&current, incompatible, "0.0.2"),
                Err(UPDATE_SIGNER_CHANGED.into())
            );
        }
        assert_eq!(
            compatible_update_identity(&current, &candidate, "0.0.3"),
            Err(UPDATE_ARCHIVE_INVALID.into())
        );
    }

    fn archive_fixture(entries: &[(&str, u8, &[u8])]) -> Vec<u8> {
        let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        let mut archive = tar::Builder::new(encoder);
        for (name, kind, data) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_mode(0o755);
            header.set_size(data.len() as u64);
            header.set_entry_type(tar::EntryType::new(*kind));
            if *kind == b'1' || *kind == b'2' {
                header.set_link_name("../../outside").unwrap();
            }
            // Raw names allow tests to construct paths a safe archive writer rejects.
            header.as_mut_bytes()[..name.len()].copy_from_slice(name.as_bytes());
            header.set_cksum();
            archive.append(&header, *data).unwrap();
        }
        archive.into_inner().unwrap().finish().unwrap()
    }

    #[test]
    fn regular_update_is_checked_in_an_isolated_directory_without_changing_bytes() {
        let bytes = archive_fixture(&[
            (
                "Cicada.app/Contents/MacOS/hanni-mvp",
                b'0',
                b"fictional executable",
            ),
            ("Cicada.app/Contents/Info.plist", b'0', b"fictional plist"),
        ]);
        let before = bytes.clone();
        let temporary = extract_update_archive(&bytes).unwrap();
        let path = temporary.path().to_path_buf();
        assert_eq!(
            std::fs::read(path.join("Cicada.app").join(EXECUTABLE)).unwrap(),
            b"fictional executable"
        );
        assert_eq!(bytes, before);
        drop(temporary);
        assert!(!path.exists());
    }

    #[test]
    fn update_rejects_paths_outside_the_single_bundle_contents() {
        for path in [
            "../outside",
            "/outside",
            "Cicada.app/Contents/../../outside",
            "Other.app/Contents/MacOS/hanni-mvp",
            "Cicada.app/outside",
            "Cicada.app",
        ] {
            assert!(
                extract_update_archive(&archive_fixture(&[(path, b'0', b"content")])).is_err(),
                "{path}"
            );
        }
    }

    #[test]
    fn update_rejects_links_devices_and_duplicate_members_before_unpacking_them() {
        for kind in [b'1', b'2', b'3', b'4', b'6'] {
            assert!(extract_update_archive(&archive_fixture(&[(
                "Cicada.app/Contents/link",
                kind,
                b""
            )]))
            .is_err());
        }
        assert!(extract_update_archive(&archive_fixture(&[
            ("Cicada.app/Contents/Info.plist", b'0', b"first"),
            ("Cicada.app/Contents/Info.plist", b'0', b"second"),
        ]))
        .is_err());
    }

    #[test]
    fn incomplete_or_oversized_update_is_rejected() {
        assert!(extract_update_archive(b"not an archive").is_err());
        assert!(extract_update_archive(&archive_fixture(&[(
            "Cicada.app/Contents/Info.plist",
            b'0',
            b"plist"
        )]))
        .is_err());
        let mut header = tar::Header::new_gnu();
        header
            .set_path("Cicada.app/Contents/MacOS/hanni-mvp")
            .unwrap();
        header.set_mode(0o755);
        header.set_size(MAX_EXPANDED_UPDATE + 1);
        header.set_entry_type(tar::EntryType::Regular);
        header.set_cksum();
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        std::io::Write::write_all(&mut encoder, header.as_bytes()).unwrap();
        assert!(extract_update_archive(&encoder.finish().unwrap()).is_err());
    }

    #[test]
    fn valid_ad_hoc_bundle_cannot_enable_an_update_or_access_migration() {
        let temporary = tempfile::tempdir().unwrap();
        let bundle = temporary.path().join("Cicada.app");
        let executable = bundle.join(EXECUTABLE);
        std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
        std::fs::copy("/usr/bin/true", &executable).unwrap();
        std::fs::write(bundle.join("Contents/Info.plist"), br#"<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>app.hanni.mvp</string><key>CFBundleExecutable</key><string>hanni-mvp</string><key>CFBundleShortVersionString</key><string>0.0.1</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>"#).unwrap();
        assert!(Command::new("/usr/bin/codesign")
            .args(["--force", "--sign", "-", "--timestamp=none"])
            .arg(&bundle)
            .output()
            .unwrap()
            .status
            .success());
        assert!(Command::new("/usr/bin/codesign")
            .args(["--verify", "--deep", "--strict"])
            .arg(&bundle)
            .output()
            .unwrap()
            .status
            .success());
        assert!(bundle_signature(&bundle).is_err());
        assert_eq!(
            verify_update_archive(&bundle, b"not used", "0.0.2"),
            Err(UPDATE_SIGNER_REQUIRED.into())
        );
        assert!(executable.is_file());
    }

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

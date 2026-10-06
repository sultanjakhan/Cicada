//! Filesystem and native identity checks for the running macOS update target.
//! Kept independent of Tauri so these guards can be tested without an app build.
use std::{
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    process::Command,
};

const EXECUTABLE: &str = "Contents/MacOS/hanni-mvp";

pub(super) fn bundle_path(executable: &Path) -> Option<&Path> {
    if !executable.is_absolute()
        || executable.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir | std::path::Component::CurDir
            )
        })
    {
        return None;
    }
    let bundle = executable.parent()?.parent()?.parent()?;
    (bundle.extension()? == "app" && executable == bundle.join(EXECUTABLE)).then_some(bundle)
}

pub(super) fn writable_bundle(home: &Path, bundle: &Path, executable: &Path) -> bool {
    if bundle.canonicalize().ok().as_deref() != Some(bundle)
        || bundle_path(executable) != Some(bundle)
        || !executable
            .symlink_metadata()
            .is_ok_and(|metadata| metadata.file_type().is_file())
        || executable.canonicalize().ok().as_deref() != Some(executable)
    {
        return false;
    }
    let Ok(owner) = home.metadata().map(|metadata| metadata.uid()) else {
        return false;
    };
    [bundle, bundle.parent().unwrap()].iter().all(|path| {
        path.metadata().is_ok_and(|metadata| {
            metadata.is_dir()
                && metadata.uid() == owner
                && metadata.mode() & 0o300 == 0o300
                && metadata.mode() & 0o022 == 0
        })
    })
}

fn bundle_identity(bundle: &Path) -> bool {
    let plist = bundle.join("Contents/Info.plist");
    if !plist
        .symlink_metadata()
        .is_ok_and(|metadata| metadata.file_type().is_file() && metadata.len() <= 64 * 1024)
        || plist.canonicalize().ok().as_deref() != Some(plist.as_path())
    {
        return false;
    }
    for (field, expected) in [
        ("CFBundleIdentifier", "app.hanni.mvp"),
        ("CFBundleExecutable", "hanni-mvp"),
        ("CFBundlePackageType", "APPL"),
    ] {
        let Ok(output) = Command::new("/usr/libexec/PlistBuddy")
            .args(["-c", &format!("Print :{field}")])
            .arg(&plist)
            .output()
        else {
            return false;
        };
        if !output.status.success()
            || String::from_utf8(output.stdout)
                .ok()
                .as_deref()
                .map(str::trim)
                != Some(expected)
        {
            return false;
        }
    }
    // Official owner installs currently use ad-hoc signing. This validates
    // integrity/identity, not Developer ID provenance. Package authenticity
    // continues to come from the updater's pinned Minisign key and hash.
    Command::new("/usr/bin/codesign")
        .args(["--verify", "--deep", "--strict", "--"])
        .arg(bundle)
        .output()
        .is_ok_and(|output| output.status.success())
}

pub(super) fn installed_bundle_in(home: &Path, executable: &Path) -> Option<PathBuf> {
    let physical_home = home.canonicalize().ok()?;
    // Resolve bundle aliases, never an executable or Contents/MacOS symlink.
    let logical_bundle = bundle_path(executable)?;
    if !executable.symlink_metadata().ok()?.file_type().is_file() {
        return None;
    }
    let bundle = logical_bundle.canonicalize().ok()?;
    let physical_executable = bundle.join(EXECUTABLE);
    if executable.canonicalize().ok()? != physical_executable
        || !writable_bundle(&physical_home, &bundle, &physical_executable)
        || !bundle_identity(&bundle)
    {
        return None;
    }
    Some(bundle)
}

#[cfg(test)]
pub(super) fn write_signed_fixture(bundle: &Path, identifier: &str) {
    std::fs::create_dir_all(bundle.join("Contents/MacOS")).unwrap();
    std::fs::copy("/bin/echo", bundle.join(EXECUTABLE)).unwrap();
    std::fs::write(bundle.join("Contents/Info.plist"), format!(
        "<?xml version=\"1.0\"?><plist version=\"1.0\"><dict><key>CFBundleIdentifier</key><string>{identifier}</string><key>CFBundleExecutable</key><string>hanni-mvp</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>"
    )).unwrap();
    let output = Command::new("/usr/bin/codesign")
        .args(["--force", "--sign", "-", "--"])
        .arg(bundle)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "fixture signing: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            static SERIAL: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
            let serial = SERIAL.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "cicada-bundle-test-{}-{serial}",
                std::process::id()
            ));
            std::fs::create_dir(&path).unwrap();
            Self(path.canonicalize().unwrap())
        }
        fn bundle(&self) -> PathBuf {
            self.0.join("Any folder & space/Renamed Cicada.app")
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn arbitrary_location_and_name_need_no_applications_alias() {
        let fixture = Fixture::new();
        let bundle = fixture.bundle();
        write_signed_fixture(&bundle, "app.hanni.mvp");
        assert_eq!(
            installed_bundle_in(&fixture.0, &bundle.join(EXECUTABLE)),
            Some(bundle)
        );
    }

    #[test]
    fn arbitrary_bundle_alias_resolves_to_physical_target() {
        let fixture = Fixture::new();
        let bundle = fixture.bundle();
        write_signed_fixture(&bundle, "app.hanni.mvp");
        let alias = fixture.0.join("Other name.app");
        symlink(&bundle, &alias).unwrap();
        assert_eq!(
            installed_bundle_in(&fixture.0, &alias.join(EXECUTABLE)),
            Some(bundle)
        );
    }

    #[test]
    fn rejects_executable_and_internal_directory_symlinks() {
        let fixture = Fixture::new();
        let bundle = fixture.bundle();
        write_signed_fixture(&bundle, "app.hanni.mvp");
        let exe = bundle.join(EXECUTABLE);
        let real = exe.with_extension("real");
        std::fs::rename(&exe, &real).unwrap();
        symlink(&real, &exe).unwrap();
        assert_eq!(installed_bundle_in(&fixture.0, &exe), None);
        std::fs::remove_file(&exe).unwrap();
        std::fs::rename(&real, &exe).unwrap();
        let macos = bundle.join("Contents/MacOS");
        let other = bundle.join("Contents/Other");
        std::fs::rename(&macos, &other).unwrap();
        symlink(&other, &macos).unwrap();
        assert_eq!(installed_bundle_in(&fixture.0, &exe), None);
    }

    #[test]
    fn rejects_wrong_identity_unsigned_and_tampered_bundles() {
        let fixture = Fixture::new();
        let bundle = fixture.bundle();
        write_signed_fixture(&bundle, "app.other.product");
        assert_eq!(
            installed_bundle_in(&fixture.0, &bundle.join(EXECUTABLE)),
            None
        );
        write_signed_fixture(&bundle, "app.hanni.mvp");
        std::fs::remove_dir_all(bundle.join("Contents/_CodeSignature")).unwrap();
        assert_eq!(
            installed_bundle_in(&fixture.0, &bundle.join(EXECUTABLE)),
            None
        );
        write_signed_fixture(&bundle, "app.hanni.mvp");
        use std::io::Write;
        std::fs::OpenOptions::new()
            .append(true)
            .open(bundle.join(EXECUTABLE))
            .unwrap()
            .write_all(b"tampered")
            .unwrap();
        assert_eq!(
            installed_bundle_in(&fixture.0, &bundle.join(EXECUTABLE)),
            None
        );
    }

    #[test]
    fn rejects_readonly_shared_and_foreign_owned_targets() {
        let fixture = Fixture::new();
        let bundle = fixture.bundle();
        write_signed_fixture(&bundle, "app.hanni.mvp");
        let exe = bundle.join(EXECUTABLE);
        for (path, mode) in [(bundle.as_path(), 0o500), (bundle.parent().unwrap(), 0o777)] {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
            assert_eq!(installed_bundle_in(&fixture.0, &exe), None);
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        assert_eq!(installed_bundle_in(Path::new("/var/empty"), &exe), None);
    }

    #[test]
    fn rejects_nonbundle_executable_wrong_leaf_and_linked_plist() {
        let fixture = Fixture::new();
        let bundle = fixture.bundle();
        write_signed_fixture(&bundle, "app.hanni.mvp");
        assert_eq!(
            installed_bundle_in(&fixture.0, Path::new("/bin/echo")),
            None
        );
        assert_eq!(bundle_path(&bundle.join("Contents/MacOS/other")), None);
        let plist = bundle.join("Contents/Info.plist");
        let target = fixture.0.join("Info.plist");
        std::fs::rename(&plist, &target).unwrap();
        symlink(&target, &plist).unwrap();
        assert_eq!(
            installed_bundle_in(&fixture.0, &bundle.join(EXECUTABLE)),
            None
        );
    }
}

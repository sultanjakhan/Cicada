fn main() {
    let root=std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("..");
    let git=|args: &[&str]| std::process::Command::new("git").args(args).current_dir(&root).output().ok()
        .filter(|r| r.status.success()).and_then(|r| String::from_utf8(r.stdout).ok()).map(|s| s.trim().to_string());
    // Rebuilding after a commit/ref move must not retain an earlier source label.
    for name in ["HEAD","packed-refs"] {
        if let Some(path)=git(&["rev-parse","--git-path",name]) {println!("cargo:rerun-if-changed={}",root.join(path).display());}
    }
    if let Some(reference)=git(&["symbolic-ref","-q","HEAD"]) {
        if let Some(path)=git(&["rev-parse","--git-path",&reference]) {println!("cargo:rerun-if-changed={}",root.join(path).display());}
    }
    let source=git(&["rev-parse","HEAD"]).filter(|s| s.len()==40 && s.bytes().all(|c| c.is_ascii_hexdigit())).unwrap_or("unknown".into());
    println!("cargo:rustc-env=CICADA_SOURCE_COMMIT={source}");
    println!("cargo:rerun-if-changed={}",root.join("package.json").display());
    let mut attributes = tauri_build::Attributes::new();
    // Build scripts run on the host. Only Windows *targets* accept MSVC
    // manifest flags; cross-compiling Android on Windows must not receive them.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        // Tauri's default resource embeds the manifest only into app binaries.
        // MockRuntime tests also link Common Controls v6 and need the same
        // activation context: https://github.com/tauri-apps/tauri/issues/13419
        attributes = attributes
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
        let manifest = std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap())
            .join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
    tauri_build::try_build(attributes).expect("build Hanni MVP resources");
}

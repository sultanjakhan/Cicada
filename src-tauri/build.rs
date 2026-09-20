fn main() {
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

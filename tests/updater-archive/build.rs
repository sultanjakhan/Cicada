use std::{env,fs,path::PathBuf};
fn main() {
    let source=PathBuf::from("../../vendor/tauri-plugin-updater/src/updater.rs");
    println!("cargo:rerun-if-changed={}",source.display());
    let source=fs::read_to_string(source).unwrap();
    let start=source.find("    fn extract_zip(&self, bytes: &[u8])").unwrap();
    let end=start+source[start..].find("    fn extract_exe(").unwrap();
    // Compile the exact shipped Windows extraction method on every test platform.
    fs::write(PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("extract.rs"),
        format!("impl Update {{\n{}\n}}", &source[start..end])).unwrap();
}

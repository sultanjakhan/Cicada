fn main() {
    println!("cargo:rerun-if-changed=src/transport.c");
    cc::Build::new()
        .file("src/transport.c")
        .flag("-fblocks")
        .flag("-mmacosx-version-min=12.0")
        .warnings_into_errors(true)
        .compile("vault_transport");
    println!("cargo:rustc-link-lib=framework=Security");
    println!("cargo:rustc-link-lib=framework=CoreFoundation");
}

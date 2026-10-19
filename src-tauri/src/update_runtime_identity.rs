//! Pinned signed installer-to-compiled-source binding. No filesystem JS identity.
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Descriptor {
    pub schema_version: u32,
    pub identifier: String,
    pub platform: String,
    pub version: String,
    pub source_commit: String,
    pub build_id: String,
    pub prepared_id: String,
    pub installer_sha256: String,
    pub installer_size: u64,
}
pub(crate) struct StoredDescriptor { pub raw: String, pub signature: String }
pub(crate) struct CompiledIdentity { pub version: String, pub source_commit: String, pub build_id: String }
fn hash(value: &str, size: usize) -> bool {
    value.len()==size && value.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
pub(crate) fn verify(raw: &str, signature: &str, key: &str) -> Result<Descriptor,String> {
    if raw.is_empty() || raw.len()>16384 || signature.len()>4096 { return Err("control_runtime_descriptor_invalid".into()); }
    crate::app_updates::verify_detached(raw.as_bytes(),signature,key)?;
    let d: Descriptor=serde_json::from_str(raw).map_err(|_| "control_runtime_descriptor_invalid")?;
    if d.schema_version!=1 || d.identifier!="app.hanni.mvp" || d.platform!="windows-x86_64"
        || semver::Version::parse(&d.version).is_err() || !hash(&d.source_commit,40) || !hash(&d.prepared_id,64)
        || !hash(&d.installer_sha256,64) || d.installer_size==0 || d.installer_size>160*1024*1024
        || d.build_id.is_empty() || d.build_id.len()>128 || !d.build_id.bytes().all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c)) {
        return Err("control_runtime_descriptor_invalid".into());
    }
    Ok(d)
}
pub(crate) fn matches(d: &Descriptor, actual: &CompiledIdentity, version: &str, prepared_id: &str) -> bool {
    d.version==version && d.prepared_id==prepared_id && d.version==actual.version
        && d.source_commit==actual.source_commit && d.build_id==actual.build_id
}
pub(crate) fn current(version: String) -> Option<CompiledIdentity> {
    let source_commit=option_env!("CICADA_SOURCE_COMMIT")?;
    if !hash(source_commit,40) {return None;}
    // include_str is compiled into this Rust image; never read package.json from disk.
    let package: serde_json::Value=serde_json::from_str(include_str!("../../package.json")).ok()?;
    let build_id=package["cicadaBuildId"].as_str()?.to_string();
    Some(CompiledIdentity {version,source_commit:source_commit.into(),build_id})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn signed_exact_source_binding_rejects_same_version_different_runtime_identity() {
        let raw=include_str!("../../tests/fixtures/updates/runtime-binding.json");
        let sig=include_str!("../../tests/fixtures/updates/runtime-binding.json.sig");
        let key=include_str!("../../tests/fixtures/updates/runtime-binding-public-key.txt");
        let d=verify(raw,sig,key).unwrap();
        let mut actual=CompiledIdentity{version:"9.0.0".into(),source_commit:"1".repeat(40),build_id:"fictional-runtime-v1".into()};
        assert!(matches(&d,&actual,"9.0.0",&"a".repeat(64)));
        actual.source_commit="2".repeat(40);assert!(!matches(&d,&actual,"9.0.0",&"a".repeat(64)));
        actual.source_commit="1".repeat(40);actual.build_id="different-build".into();assert!(!matches(&d,&actual,"9.0.0",&"a".repeat(64)));
        actual.build_id="fictional-runtime-v1".into();
        assert!(!matches(&d,&actual,"9.0.0",&"b".repeat(64)));
        assert!(verify(&raw.replace("fictional-runtime-v1","tampered-runtime-v1"),sig,key).is_err());
        assert!(verify(raw,"invalid",key).is_err());
        assert!(verify(raw,sig,crate::app_updates::CONTROL_PUBLIC_KEY).is_err(),"fixture key cannot authorize production");
    }
}

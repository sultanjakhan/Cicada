//! Opt-in, current-user macOS Unix socket transport. No TCP listener.
use sha2::{Digest, Sha256};
use std::{
    fs::{self, Metadata, OpenOptions},
    io::{ErrorKind, Read},
    os::{fd::AsRawFd, unix::{fs::{FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt}, ffi::OsStrExt}},
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::{UnixListener, UnixStream}};
use serde::Deserialize;

pub(crate) const FRAME_LIMIT: usize = 64 * 1024;
pub(crate) const REPLY_LIMIT: usize = 1024 * 1024;
const CONFIG: &str = "cicada-agent-access.json";
unsafe extern "C" {
    fn geteuid() -> u32;
    fn getpeereid(socket: i32, uid: *mut u32, gid: *mut u32) -> i32;
}
fn uid() -> u32 { unsafe { geteuid() } }
fn error() -> String { "agent_socket_configuration_rejected".into() }
fn identity(meta: &Metadata) -> (u64, u64) { (meta.dev(), meta.ino()) }
fn owner(meta: &Metadata, expected: u32) -> bool { meta.uid() == expected }
fn canonical(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() { return Err(error()) }
    let resolved = path.canonicalize().map_err(|_| error())?;
    if resolved != path { return Err(error()) }
    Ok(resolved)
}
fn directory(path: &Path, private: bool) -> Result<Metadata, String> {
    canonical(path)?;
    let meta = fs::symlink_metadata(path).map_err(|_| error())?;
    if !meta.is_dir() || !owner(&meta, uid()) ||
        (private && meta.mode() & 0o777 != 0o700) ||
        (!private && meta.mode() & 0o022 != 0) { return Err(error()) }
    // A writable ancestor could replace even a private leaf directory.
    // Root-owned sticky temporary roots are safe for a current-user leaf.
    for ancestor in path.ancestors().skip(1) {
        let m = fs::symlink_metadata(ancestor).map_err(|_| error())?;
        if !m.is_dir() || (m.uid() != uid() && m.uid() != 0) ||
            (m.mode() & 0o022 != 0 && !(m.uid() == 0 && m.mode() & 0o1000 != 0)) {
            return Err(error())
        }
    }
    Ok(meta)
}
pub(crate) fn endpoint(directory_path: &Path, profile: &Path) -> Result<PathBuf, String> {
    directory(directory_path, true)?;
    directory(profile, false)?;
    let profile = profile.to_str().ok_or_else(error)?;
    let hash = hex::encode(Sha256::digest(format!("{}\n{profile}", uid()).as_bytes()));
    let path = directory_path.join(format!("cicada-{}.sock", &hash[..32]));
    if path.as_os_str().as_bytes().len() >= 104 { return Err(error()) }
    Ok(path)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Config { version: u32, socket_directory: PathBuf }
/// Missing configuration means disabled. A malformed grant never enables access.
pub(crate) fn configured_directory(profile: &Path) -> Result<Option<PathBuf>, String> {
    directory(profile, false)?;
    let path = profile.join(CONFIG);
    let before = match fs::symlink_metadata(&path) {
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(error()),
        Ok(value) => value,
    };
    if !before.is_file() || !owner(&before, uid()) || before.mode() & 0o777 != 0o600 || before.len() > 4096 { return Err(error()) }
    // O_NOFOLLOW prevents replacement with a symlink between lstat and open.
    // Darwin O_NOFOLLOW is 0x100; this module is compiled only on macOS.
    let mut file = OpenOptions::new().read(true).custom_flags(0x100).open(&path).map_err(|_| error())?;
    let after = file.metadata().map_err(|_| error())?;
    if identity(&before) != identity(&after) { return Err(error()) }
    let mut raw = Vec::new();
    file.by_ref().take(4097).read_to_end(&mut raw).map_err(|_| error())?;
    if raw.len() > 4096 { return Err(error()) }
    let config: Config = serde_json::from_slice(&raw).map_err(|_| error())?;
    if config.version != 1 { return Err(error()) }
    endpoint(&config.socket_directory, profile)?;
    Ok(Some(config.socket_directory))
}
fn socket_metadata(path: &Path) -> Result<Metadata, String> {
    let meta = fs::symlink_metadata(path).map_err(|_| error())?;
    if !meta.file_type().is_socket() || !owner(&meta, uid()) || meta.mode() & 0o777 != 0o600 { return Err(error()) }
    Ok(meta)
}
fn peer_is_owner(stream: &UnixStream, expected: u32) -> bool {
    let (mut peer_uid, mut peer_gid) = (u32::MAX, u32::MAX);
    unsafe { getpeereid(stream.as_raw_fd(), &mut peer_uid, &mut peer_gid) == 0 && peer_uid == expected }
}
pub(crate) struct Endpoint { listener: UnixListener, path: PathBuf, socket_identity: (u64, u64) }
impl Endpoint {
    pub(crate) async fn bind(directory_path: &Path, profile: &Path) -> Result<Self, String> {
        let path = endpoint(directory_path, profile)?;
        let parent_identity = identity(&directory(directory_path, true)?);
        match fs::symlink_metadata(&path) {
            Ok(_) => {
                let stale = socket_metadata(&path)?;
                match tokio::time::timeout(Duration::from_millis(300), UnixStream::connect(&path)).await {
                    Ok(Err(e)) if e.kind() == ErrorKind::ConnectionRefused => {
                        if identity(&socket_metadata(&path)?) != identity(&stale) { return Err(error()) }
                        fs::remove_file(&path).map_err(|_| error())?;
                    }
                    _ => return Err("agent_socket_already_in_use".into()),
                }
            }
            Err(e) if e.kind() == ErrorKind::NotFound => {}
            Err(_) => return Err(error()),
        }
        if identity(&directory(directory_path, true)?) != parent_identity { return Err(error()) }
        let listener = UnixListener::bind(&path).map_err(|_| error())?;
        // The private directory prevents other users reaching the socket while
        // the mode is tightened. No process-global umask changes are needed.
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).map_err(|_| error())?;
        let socket_identity = identity(&socket_metadata(&path)?);
        if identity(&directory(directory_path, true)?) != parent_identity { return Err(error()) }
        Ok(Self { listener, path, socket_identity })
    }
    pub(crate) async fn accept(&self) -> Result<UnixStream, String> {
        let (stream, _) = self.listener.accept().await.map_err(|_| "agent_socket_unavailable")?;
        if !peer_is_owner(&stream, uid()) { return Err("agent_socket_peer_rejected".into()) }
        Ok(stream)
    }
    #[cfg(test)]
    fn path(&self) -> &Path { &self.path }
}
impl Drop for Endpoint {
    fn drop(&mut self) {
        if socket_metadata(&self.path).is_ok_and(|m| identity(&m) == self.socket_identity) {
            let _ = fs::remove_file(&self.path);
        }
    }
}
pub(crate) async fn read_frame(stream: &mut UnixStream, limit: usize, timeout: Duration) -> Result<Vec<u8>, String> {
    tokio::time::timeout(timeout, async {
        let mut bytes = Vec::new();
        let mut one = [0u8];
        while bytes.len() < limit {
            if stream.read(&mut one).await.map_err(|_| "invalid_agent_frame")? == 0 {
                return Err("invalid_agent_frame".into())
            }
            if one[0] == b'\n' { return Ok(bytes) }
            bytes.push(one[0]);
        }
        Err("invalid_agent_frame".into())
    }).await.map_err(|_| "invalid_agent_frame".to_string())?
}
pub(crate) async fn write_frame(stream: &mut UnixStream, bytes: &[u8]) -> Result<(), String> {
    if bytes.len() + 1 > REPLY_LIMIT { return Err("agent_response_too_large".into()) }
    tokio::time::timeout(Duration::from_secs(3), async {
        stream.write_all(bytes).await?;
        stream.write_all(b"\n").await?;
        stream.flush().await
    }).await.map_err(|_| "agent_outcome_unknown".to_string())?
        .map_err(|_| "agent_outcome_unknown".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::{fs::symlink, net::UnixListener as StdListener};
    fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let root = tempfile::Builder::new().prefix("cas-").tempdir_in("/private/tmp").unwrap();
        let physical = root.path().canonicalize().unwrap();
        let profile = physical.join("p");
        let sockets = physical.join("s");
        fs::create_dir(&profile).unwrap(); fs::create_dir(&sockets).unwrap();
        fs::set_permissions(&profile, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(&sockets, fs::Permissions::from_mode(0o700)).unwrap();
        (root, profile, sockets)
    }
    #[test]
    fn opt_in_is_missing_by_default_and_strict() {
        let (_root, profile, sockets) = fixture();
        assert_eq!(configured_directory(&profile).unwrap(), None);
        let path = profile.join(CONFIG);
        fs::write(&path, serde_json::json!({"version":1,"socketDirectory":sockets} ).to_string()).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(configured_directory(&profile).unwrap(), Some(sockets.clone()));
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(configured_directory(&profile).is_err());
        fs::remove_file(&path).unwrap();
        let source = profile.join("source");
        fs::write(&source, "{}").unwrap(); symlink(&source, &path).unwrap();
        assert!(configured_directory(&profile).is_err());
        fs::remove_file(&path).unwrap();
        fs::write(&path, serde_json::json!({"version":2,"socketDirectory":sockets}).to_string()).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(configured_directory(&profile).is_err());
    }
    #[test]
    fn profile_directory_and_length_guards() {
        let (_root, profile, sockets) = fixture();
        assert_eq!(endpoint(&sockets, &profile).unwrap(), endpoint(&sockets, &profile).unwrap());
        let other = profile.with_file_name("other"); fs::create_dir(&other).unwrap();
        assert_ne!(endpoint(&sockets, &profile).unwrap(), endpoint(&sockets, &other).unwrap());
        assert!(endpoint(Path::new("relative"), &profile).is_err());
        let link = sockets.with_file_name("link"); symlink(&sockets, &link).unwrap();
        assert!(endpoint(&link, &profile).is_err());
        fs::set_permissions(&sockets, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(endpoint(&sockets, &profile).is_err());
        fs::set_permissions(&sockets, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(&profile, fs::Permissions::from_mode(0o777)).unwrap();
        assert!(endpoint(&sockets, &profile).is_err());
        fs::set_permissions(&profile, fs::Permissions::from_mode(0o700)).unwrap();
        let long = sockets.join("a".repeat(100)); fs::create_dir(&long).unwrap();
        fs::set_permissions(&long, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(endpoint(&long, &profile).is_err());
        assert!(!owner(&fs::metadata(&profile).unwrap(), uid().wrapping_add(1)));
    }
    #[tokio::test]
    async fn bind_preserves_foreign_nodes_and_recovers_only_stale_own_socket() {
        let (_root, profile, sockets) = fixture();
        let path = endpoint(&sockets, &profile).unwrap();
        fs::write(&path, "keep").unwrap();
        assert!(Endpoint::bind(&sockets, &profile).await.is_err());
        assert_eq!(fs::read(&path).unwrap(), b"keep");
        fs::remove_file(&path).unwrap();
        symlink(&profile, &path).unwrap();
        assert!(Endpoint::bind(&sockets, &profile).await.is_err());
        assert!(fs::symlink_metadata(&path).unwrap().file_type().is_symlink());
        fs::remove_file(&path).unwrap();
        let stale = StdListener::bind(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        drop(stale);
        let endpoint = Endpoint::bind(&sockets, &profile).await.unwrap();
        assert_eq!(fs::metadata(&path).unwrap().mode() & 0o777, 0o600);
        assert!(Endpoint::bind(&sockets, &profile).await.is_err());
        drop(endpoint);
        assert!(!path.exists());
    }
    #[tokio::test]
    async fn authenticates_current_peer_and_rejects_wrong_expected_uid() {
        let (_root, profile, sockets) = fixture();
        let endpoint = Endpoint::bind(&sockets, &profile).await.unwrap();
        let client = UnixStream::connect(endpoint.path()).await.unwrap();
        let server = endpoint.accept().await.unwrap();
        assert!(peer_is_owner(&client, uid()));
        assert!(!peer_is_owner(&server, uid().wrapping_add(1)));
    }
    #[tokio::test]
    async fn bounded_frames_and_response_are_complete() {
        let (mut a, mut b) = UnixStream::pair().unwrap();
        b.write_all(b"synthetic\n").await.unwrap();
        assert_eq!(read_frame(&mut a, FRAME_LIMIT, Duration::from_secs(1)).await.unwrap(), b"synthetic");
        write_frame(&mut a, b"{\"ok\":true}").await.unwrap();
        assert_eq!(read_frame(&mut b, REPLY_LIMIT, Duration::from_secs(1)).await.unwrap(), b"{\"ok\":true}");
        b.write_all(b"12345678").await.unwrap();
        assert!(read_frame(&mut a, 8, Duration::from_secs(1)).await.is_err());
        assert!(write_frame(&mut a, &vec![0; REPLY_LIMIT]).await.is_err());
        assert!(read_frame(&mut a, FRAME_LIMIT, Duration::from_millis(10)).await.is_err());
        drop(b);
        assert!(read_frame(&mut a, FRAME_LIMIT, Duration::from_secs(1)).await.is_err());
    }
}

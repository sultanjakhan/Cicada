//! Signed application packages. Calendar data and relay credentials never enter this channel.
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State};

const PUBLIC_KEY: &str = include_str!("../update-public-key.txt");
const MAX_PACKAGE: u64 = 160 * 1024 * 1024;
const MAX_MANIFEST: u64 = 64 * 1024;
const UPDATE_URL: Option<&str> = option_env!("HANNI_MVP_UPDATES_URL");
const UPDATE_TOKEN: Option<&str> = option_env!("HANNI_MVP_UPDATES_TOKEN");

#[derive(Clone, Debug, Deserialize)]
struct Package {
    url: String,
    signature: String,
    sha256: String,
    size: u64,
    version_code: Option<u64>,
}
#[derive(Clone, Debug, Deserialize)]
struct Manifest {
    version: String,
    #[serde(default)]
    notes: String,
    platforms: HashMap<String, Package>,
}
#[derive(Clone)]
struct Candidate {
    version: String,
    package: Package,
}
#[derive(Clone, Default, Serialize)]
pub struct UpdateStatus {
    configured: bool,
    installed_version: String,
    platform: String,
    phase: String,
    version: Option<String>,
    notes: String,
    size: u64,
    downloaded: u64,
    error: Option<String>,
}
#[derive(Default)]
pub struct UpdateState {
    candidate: Mutex<Option<Candidate>>,
    status: Mutex<UpdateStatus>,
    busy: AtomicBool,
}
struct Busy<'a>(&'a AtomicBool);
impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
impl UpdateState {
    fn acquire(&self) -> Result<Busy<'_>, String> {
        self.busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "Обновление уже выполняется.".to_string())?;
        Ok(Busy(&self.busy))
    }
    fn change(&self, app: &AppHandle, edit: impl FnOnce(&mut UpdateStatus)) {
        if let Ok(mut status) = self.status.lock() {
            edit(&mut status);
            status.configured = config().is_ok();
            status.installed_version = app.package_info().version.to_string();
            status.platform = platform().to_string();
            let _ = app.emit("hanni:update-status", status.clone());
        }
    }
    fn snapshot(&self, app: &AppHandle) -> UpdateStatus {
        let mut status = self.status.lock().map(|s| s.clone()).unwrap_or_default();
        status.configured = config().is_ok();
        status.installed_version = app.package_info().version.to_string();
        status.platform = platform().to_string();
        if status.phase.is_empty() {
            status.phase = "idle".into();
        }
        status
    }
}
fn platform() -> &'static str {
    if cfg!(target_os = "android") {
        "android-aarch64"
    } else if cfg!(windows) {
        "windows-x86_64"
    } else {
        "unsupported"
    }
}
fn config() -> Result<(reqwest::Url, &'static str), String> {
    let url = UPDATE_URL
        .and_then(|s| reqwest::Url::parse(s).ok())
        .ok_or("Канал обновлений не настроен.")?;
    let token = UPDATE_TOKEN
        .filter(|s| s.len() >= 32)
        .ok_or("Канал обновлений не настроен.")?;
    if url.scheme() != "https"
        || url.username() != ""
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || platform() == "unsupported"
    {
        return Err("Канал обновлений не поддерживается.".into());
    }
    Ok((url, token))
}
fn package_url(feed: &reqwest::Url, value: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(value).map_err(|_| "Некорректный адрес обновления.")?;
    if url.origin() != feed.origin()
        || url.scheme() != "https"
        || url.query().is_some()
        || url.fragment().is_some()
        || url.username() != ""
        || url.password().is_some()
        || !url.path().starts_with("/releases/")
    {
        return Err("Обновление с неизвестного сервера отклонено.".into());
    }
    Ok(url)
}
fn select(
    manifest: Manifest,
    current: &semver::Version,
    target: &str,
    feed: &reqwest::Url,
) -> Result<Option<(Candidate, String)>, String> {
    let version =
        semver::Version::parse(&manifest.version).map_err(|_| "Некорректная версия обновления.")?;
    if !version.pre.is_empty() || !version.build.is_empty() {
        return Err("Тестовый выпуск отклонён.".into());
    }
    if version <= *current {
        return Ok(None);
    }
    let Some(package) = manifest.platforms.get(target).cloned() else {
        return Ok(None);
    };
    package_url(feed, &package.url)?;
    if package.size == 0
        || package.size > MAX_PACKAGE
        || package.signature.len() > 4096
        || package.signature.is_empty()
        || package.sha256.len() != 64
        || !package.sha256.bytes().all(|x| x.is_ascii_hexdigit())
    {
        return Err("Некорректные сведения о пакете обновления.".into());
    }
    if target == "android-aarch64" {
        if version.minor >= 1000 || version.patch >= 1000 {
            return Err("Некорректная версия APK.".into());
        }
        let code = version
            .major
            .checked_mul(1_000_000)
            .and_then(|v| {
                version
                    .minor
                    .checked_mul(1_000)
                    .and_then(|m| v.checked_add(m))
            })
            .and_then(|v| v.checked_add(version.patch));
        if code != package.version_code || code.is_none() {
            return Err("Версия APK не соответствует выпуску.".into());
        }
    }
    Ok(Some((
        Candidate {
            version: version.to_string(),
            package,
        },
        manifest.notes.chars().take(2000).collect(),
    )))
}
async fn fetch(
    url: reqwest::Url,
    token: &str,
    limit: u64,
    mut progress: impl FnMut(u64),
) -> Result<Vec<u8>, String> {
    let client = reqwest::Client::builder()
        .user_agent(concat!("Hanni-MVP-Updater/", env!("CARGO_PKG_VERSION")))
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|_| "Не удалось подготовить загрузку.")?;
    let mut response = client
        .get(url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|_| "Не удалось связаться с сервером обновлений. Повтори позже.")?;
    if !response.status().is_success() {
        return Err("Сервер обновлений временно недоступен. Повтори позже.".into());
    }
    if response.content_length().is_some_and(|n| n > limit) {
        return Err("Пакет обновления слишком большой.".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Загрузка прервана. Повтори попытку.")?
    {
        if bytes.len() as u64 + chunk.len() as u64 > limit {
            return Err("Пакет обновления слишком большой.".into());
        }
        bytes.extend_from_slice(&chunk);
        progress(bytes.len() as u64);
    }
    Ok(bytes)
}
fn verify(bytes: &[u8], package: &Package, key: &str) -> Result<(), String> {
    if bytes.len() as u64 != package.size
        || hex::encode(Sha256::digest(bytes)) != package.sha256.to_ascii_lowercase()
    {
        return Err("Пакет повреждён. Установка отменена.".into());
    }
    let decode = |s: &str| -> Result<String, String> {
        String::from_utf8(
            base64::engine::general_purpose::STANDARD
                .decode(s.trim())
                .map_err(|_| "Некорректная подпись обновления.")?,
        )
        .map_err(|_| "Некорректная подпись обновления.".into())
    };
    let key = minisign_verify::PublicKey::decode(&decode(key)?)
        .map_err(|_| "Некорректный ключ обновлений.")?;
    let signature = minisign_verify::Signature::decode(&decode(&package.signature)?)
        .map_err(|_| "Некорректная подпись обновления.")?;
    key.verify(bytes, &signature, true)
        .map_err(|_| "Подпись обновления не прошла проверку. Установка отменена.".into())
}
#[tauri::command]
pub fn mvp_update_status(app: AppHandle, state: State<'_, UpdateState>) -> UpdateStatus {
    state.snapshot(&app)
}

#[tauri::command]
pub async fn mvp_update_check(
    app: AppHandle,
    state: State<'_, UpdateState>,
) -> Result<UpdateStatus, String> {
    if config().is_err() {
        return Ok(state.snapshot(&app));
    }
    let _busy = state.acquire()?;
    state.change(&app, |s| {
        s.phase = "checking".into();
        s.error = None;
    });
    let result: Result<UpdateStatus, String> = async {
        let (feed, token) = config()?;
        let bytes = fetch(feed.clone(), token, MAX_MANIFEST, |_| {}).await?;
        let manifest: Manifest = serde_json::from_slice(&bytes)
            .map_err(|_| "Сервер вернул неверное описание обновления.")?;
        let selected = select(manifest, &app.package_info().version, platform(), &feed)?;
        let mut pending = state
            .candidate
            .lock()
            .map_err(|_| "Не удалось проверить обновление.")?;
        if let Some((candidate, notes)) = selected {
            state.change(&app, |s| {
                s.phase = "available".into();
                s.version = Some(candidate.version.clone());
                s.notes = notes;
                s.size = candidate.package.size;
                s.downloaded = 0;
            });
            *pending = Some(candidate);
        } else {
            *pending = None;
            state.change(&app, |s| {
                s.phase = "current".into();
                s.version = None;
                s.notes.clear();
                s.size = 0;
                s.downloaded = 0;
            });
        }
        Ok(state.snapshot(&app))
    }
    .await;
    if let Err(ref error) = result {
        state.change(&app, |s| {
            s.phase = "error".into();
            s.error = Some(error.clone());
        });
    }
    result
}

#[tauri::command(rename_all = "camelCase")]
pub async fn mvp_update_install(
    app: AppHandle,
    state: State<'_, UpdateState>,
    expected_version: String,
) -> Result<UpdateStatus, String> {
    let _busy = state.acquire()?;
    let candidate = state
        .candidate
        .lock()
        .map_err(|_| "Повтори проверку обновлений.")?
        .clone()
        .ok_or("Сначала проверь обновления.")?;
    if candidate.version != expected_version {
        return Err("Доступная версия изменилась. Повтори проверку.".into());
    }
    let result: Result<UpdateStatus, String> = async {
        let (feed, token) = config()?;
        let url = package_url(&feed, &candidate.package.url)?;
        state.change(&app, |s| {
            s.phase = "downloading".into();
            s.error = None;
            s.downloaded = 0;
        });
        let mut last = 0;
        let bytes = fetch(url, token, candidate.package.size, |received| {
            if received - last >= 256 * 1024 || received == candidate.package.size {
                last = received;
                state.change(&app, |s| s.downloaded = received);
            }
        })
        .await?;
        verify(&bytes, &candidate.package, PUBLIC_KEY)?;
        // Consistent backup before either platform installer may stop the process.
        crate::create_backup(app.clone(), app.state::<crate::AppState>())?;
        #[cfg(target_os = "android")]
        {
            use hanni_mvp_android_installer::{
                AndroidInstallerExt, InstallStatus, InstallVerifiedRequest,
            };
            let dir = app
                .path()
                .app_cache_dir()
                .map_err(|_| "Не удалось открыть папку обновлений.")?
                .join("updates");
            std::fs::create_dir_all(&dir).map_err(|_| "Не удалось сохранить обновление.")?;
            let path = dir.join(format!("hanni-mvp-{}.apk", candidate.version));
            let temporary = path.with_extension("part");
            std::fs::write(&temporary, &bytes).map_err(|_| "Недостаточно места для обновления.")?;
            if path.exists() {
                std::fs::remove_file(&path)
                    .map_err(|_| "Не удалось заменить загруженный пакет.")?;
            }
            std::fs::rename(&temporary, &path).map_err(|_| "Не удалось сохранить обновление.")?;
            let result = app
                .android_installer()
                .install_verified(InstallVerifiedRequest {
                    path: path.to_string_lossy().into_owned(),
                    expected_version_code: candidate.package.version_code.unwrap(),
                    expected_sha256: candidate.package.sha256.to_ascii_lowercase(),
                })?;
            state.change(&app, |s| {
                s.phase = match result {
                    InstallStatus::Launched => "installer_opened",
                    InstallStatus::PermissionRequired => "permission_required",
                    InstallStatus::Unsupported => "unsupported",
                }
                .into()
            });
        }
        #[cfg(any(windows, target_os = "macos", target_os = "linux"))]
        {
            use tauri_plugin_updater::UpdaterExt;
            let update = app
                .updater_builder()
                .pubkey(PUBLIC_KEY.trim())
                .endpoints(vec![feed])
                .map_err(|_| "Некорректный канал обновлений.")?
                .header("Authorization", format!("Bearer {token}"))
                .map_err(|_| "Некорректный доступ к обновлениям.")?
                .build()
                .map_err(|_| "Не удалось подготовить установку.")?
                .check()
                .await
                .map_err(|_| "Не удалось подтвердить выпуск.")?
                .ok_or("Выпуск изменился. Повтори проверку.")?;
            if update.version != candidate.version
                || update.signature != candidate.package.signature
                || update.download_url.as_str() != candidate.package.url
            {
                return Err("Выпуск изменился. Повтори проверку.".into());
            }
            state.change(&app, |s| s.phase = "installer_opened".into());
            update
                .install(&bytes)
                .map_err(|_| "Не удалось запустить установку. Повтори попытку.")?;
        }
        Ok(state.snapshot(&app))
    }
    .await;
    if let Err(ref error) = result {
        state.change(&app, |s| {
            s.phase = "error".into();
            s.error = Some(error.clone());
        });
    }
    result
}

#[tauri::command]
pub fn mvp_update_open_permission(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        use hanni_mvp_android_installer::AndroidInstallerExt;
        app.android_installer().open_install_permission()?;
    }
    #[cfg(not(target_os = "android"))]
    let _ = app;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn signed_payload_is_accepted_but_replaced_bytes_are_rejected() {
        let bytes = include_bytes!("../../tests/fixtures/updates/sample.txt");
        let key = include_str!("../../tests/fixtures/updates/public-key.txt");
        let mut package = Package {
            url: String::new(),
            signature: include_str!("../../tests/fixtures/updates/sample.txt.sig")
                .trim()
                .into(),
            sha256: hex::encode(Sha256::digest(bytes)),
            size: bytes.len() as u64,
            version_code: None,
        };
        verify(bytes, &package, key).unwrap();
        let replaced = vec![b'x'; bytes.len()];
        package.sha256 = hex::encode(Sha256::digest(&replaced));
        assert!(verify(&replaced, &package, key).is_err());
        assert!(verify(bytes, &package, PUBLIC_KEY).is_err());
    }
    fn manifest() -> Manifest {
        serde_json::from_value(serde_json::json!({"version":"0.3.5","platforms":{"android-aarch64":{"url":"https://updates.example/releases/app.apk","signature":"signature","sha256":"a".repeat(64),"size":100,"version_code":3005}}})).unwrap()
    }
    #[test]
    fn refuses_downgrades() {
        let current = semver::Version::parse("0.3.5").unwrap();
        assert!(select(
            manifest(),
            &current,
            "android-aarch64",
            &reqwest::Url::parse("https://updates.example/latest.json").unwrap()
        )
        .unwrap()
        .is_none());
    }
    #[test]
    fn accepts_newer_same_origin() {
        assert!(select(
            manifest(),
            &semver::Version::parse("0.3.4").unwrap(),
            "android-aarch64",
            &reqwest::Url::parse("https://updates.example/latest.json").unwrap()
        )
        .unwrap()
        .is_some());
    }
    #[test]
    fn rejects_cross_origin_and_mismatched_code() {
        let feed = reqwest::Url::parse("https://updates.example/latest.json").unwrap();
        let current = semver::Version::parse("0.3.4").unwrap();
        let mut m = manifest();
        m.platforms.get_mut("android-aarch64").unwrap().url =
            "https://other.example/releases/app.apk".into();
        assert!(select(m, &current, "android-aarch64", &feed).is_err());
        let mut m = manifest();
        m.platforms.get_mut("android-aarch64").unwrap().version_code = Some(3006);
        assert!(select(m, &current, "android-aarch64", &feed).is_err());
    }
    #[test]
    fn rejects_invalid_signature_before_installer() {
        let mut p = manifest().platforms.remove("android-aarch64").unwrap();
        let bytes = b"invalid";
        p.size = bytes.len() as u64;
        p.sha256 = hex::encode(Sha256::digest(bytes));
        assert!(verify(bytes, &p, PUBLIC_KEY).is_err());
    }
}

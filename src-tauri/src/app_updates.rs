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
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State};

const PUBLIC_KEY: &str = include_str!("../update-public-key.txt");
const MAX_PACKAGE: u64 = 160 * 1024 * 1024;
const MAX_MANIFEST: u64 = 64 * 1024;
const UPDATE_URL: Option<&str> = option_env!("HANNI_MVP_UPDATES_URL");
const UPDATE_TOKEN: Option<&str> = option_env!("HANNI_MVP_UPDATES_TOKEN");

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
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
#[derive(Clone, Serialize, Deserialize)]
struct Candidate {
    version: String,
    package: Package,
}
#[derive(Serialize, Deserialize)]
struct PreparedUpdate {
    candidate: Candidate,
    prepared_at: String,
}
#[derive(Clone, Default, Serialize)]
pub struct UpdateStatus {
    configured: bool,
    installed_version: String,
    platform: String,
    pub(crate) phase: String,
    pub(crate) version: Option<String>,
    notes: String,
    size: u64,
    downloaded: u64,
    error: Option<String>,
    background_error: Option<String>,
}
#[derive(Default)]
pub struct UpdateState {
    candidate: Mutex<Option<Candidate>>,
    status: Mutex<UpdateStatus>,
    /// A renderer can grant this only while it has no uncommitted editor state
    /// and is hidden.  Native installation consumes the lease instead of
    /// trusting an old visibility event.
    ui_safe: Mutex<Option<UiLease>>,
    busy: AtomicBool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateActivity {
    pub safe_to_install: bool,
    pub hidden: bool,
}

struct UiLease {
    since: Instant,
    reported_at: Instant,
}
impl UiLease {
    fn eligible_at(&self, now: Instant) -> bool {
        now.saturating_duration_since(self.since) >= Duration::from_secs(30)
            && now.saturating_duration_since(self.reported_at) <= Duration::from_secs(90)
    }
}
struct Busy<'a>(&'a AtomicBool);
impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
impl UpdateState {
    fn report_activity(&self, activity: UpdateActivity, now: Instant) {
        if let Ok(mut lease) = self.ui_safe.lock() {
            if activity.safe_to_install && activity.hidden {
                match lease.as_mut() {
                    Some(current)
                        if now.saturating_duration_since(current.reported_at)
                            <= Duration::from_secs(90) =>
                    {
                        current.reported_at = now
                    }
                    _ => {
                        *lease = Some(UiLease {
                            since: now,
                            reported_at: now,
                        })
                    }
                }
            } else {
                *lease = None;
            }
        }
    }
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

fn prepared_paths(
    app: &AppHandle,
    version: &str,
) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|_| "Не удалось открыть папку обновлений.")?
        .join("updates");
    std::fs::create_dir_all(&dir).map_err(|_| "Не удалось создать папку обновлений.")?;
    Ok((
        dir.join(format!("hanni-mvp-{version}.package")),
        dir.join("prepared.json"),
    ))
}

fn read_prepared(app: &AppHandle, candidate: &Candidate) -> Result<Option<Vec<u8>>, String> {
    let (path, meta) = prepared_paths(app, &candidate.version)?;
    if !meta.exists() {
        return Ok(None);
    }
    let length = std::fs::metadata(&meta)
        .map_err(|_| "Не удалось прочитать подготовленное обновление.")?
        .len();
    if length == 0 || length > MAX_MANIFEST {
        return Err("Подготовленное обновление повреждено.".into());
    }
    let raw =
        std::fs::read(&meta).map_err(|_| "Не удалось прочитать подготовленное обновление.")?;
    let saved: PreparedUpdate =
        serde_json::from_slice(&raw).map_err(|_| "Подготовленное обновление повреждено.")?;
    if saved.candidate.version != candidate.version || saved.candidate.package != candidate.package
    {
        return Err("Подготовленное обновление не соответствует выпуску.".into());
    }
    if std::fs::metadata(&path)
        .map_err(|_| "Подготовленный пакет не найден.")?
        .len()
        != candidate.package.size
    {
        return Err("Подготовленный пакет повреждён.".into());
    }
    let bytes = std::fs::read(&path).map_err(|_| "Подготовленный пакет не найден.")?;
    verify(&bytes, &candidate.package, PUBLIC_KEY)?;
    Ok(Some(bytes))
}

/// Downloads a selected release into private cache and records it atomically.
/// It deliberately does not hand the package to an installer.
#[tauri::command]
pub async fn mvp_update_prepare(
    app: AppHandle,
    state: State<'_, UpdateState>,
) -> Result<UpdateStatus, String> {
    let _busy = state.acquire()?;
    let candidate = state
        .candidate
        .lock()
        .map_err(|_| "Повтори проверку обновлений.")?
        .clone()
        .ok_or("Сначала проверь обновления.")?;
    let result: Result<UpdateStatus, String> = async {
        // A missing, superseded or corrupt cache is replaced only by freshly
        // downloaded bytes that pass the pinned signature check below.
        if matches!(read_prepared(&app, &candidate), Ok(Some(_))) {
            state.change(&app, |s| {
                s.phase = "prepared".into();
                s.downloaded = candidate.package.size;
            });
            return Ok(state.snapshot(&app));
        }
        let (feed, token) = config()?;
        let url = package_url(&feed, &candidate.package.url)?;
        state.change(&app, |s| {
            s.phase = "downloading".into();
            s.error = None;
            s.downloaded = 0;
        });
        let bytes = fetch(url, token, candidate.package.size, |received| {
            state.change(&app, |s| s.downloaded = received)
        })
        .await?;
        verify(&bytes, &candidate.package, PUBLIC_KEY)?;
        let (path, meta) = prepared_paths(&app, &candidate.version)?;
        crate::update_journal::atomic_write(&path, &bytes)?;
        let raw = serde_json::to_vec(&PreparedUpdate {
            candidate: candidate.clone(),
            prepared_at: chrono::Utc::now().to_rfc3339(),
        })
        .map_err(|_| "Не удалось записать состояние обновления.")?;
        crate::update_journal::atomic_write(&meta, &raw)?;
        state.change(&app, |s| {
            s.phase = "prepared".into();
            s.downloaded = candidate.package.size;
        });
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

/// Native polling survives a renderer reload.  Installation remains guarded by
/// the renderer lease (or by the separate closed-app runner), so this may only
/// check and prepare a verified package.
pub fn start(app: AppHandle) {
    if config().is_err() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(8)).await;
        #[cfg(target_os = "android")]
        {
            use hanni_mvp_android_installer::AndroidInstallerExt;
            if !app
                .android_installer()
                .schedule_auto_install()
                .is_ok_and(|result| result.scheduled)
            {
                app.state::<UpdateState>().change(&app, |s| {
                    s.background_error =
                        Some("Не удалось включить фоновые проверки Android.".into())
                });
            }
        }
        let mut next_check = Instant::now();
        let mut failures = 0u32;
        loop {
            let observed = mvp_update_status(app.clone(), app.state::<UpdateState>());
            if !matches!(
                observed.phase.as_str(),
                "installing" | "installer_opened" | "confirmation_required" | "permission_required"
            ) {
                if observed.phase == "idle" || Instant::now() >= next_check {
                    match mvp_update_check(app.clone(), app.state::<UpdateState>()).await {
                        Ok(_) => {
                            failures = 0;
                            next_check = Instant::now() + Duration::from_secs(6 * 60 * 60);
                        }
                        Err(_) => {
                            failures = failures.saturating_add(1);
                            next_check = Instant::now()
                                + Duration::from_secs(crate::update_journal::retry_seconds(
                                    failures,
                                ));
                        }
                    }
                }
                let status = app.state::<UpdateState>().snapshot(&app);
                if status.phase == "available" {
                    if mvp_update_prepare(app.clone(), app.state::<UpdateState>())
                        .await
                        .is_err()
                    {
                        failures = failures.saturating_add(1);
                        next_check = Instant::now()
                            + Duration::from_secs(crate::update_journal::retry_seconds(failures));
                    }
                }
                let status = app.state::<UpdateState>().snapshot(&app);
                if matches!(status.phase.as_str(), "prepared" | "deferred") {
                    if let Some(version) = status.version {
                        if let Err(error) = mvp_update_auto_install(
                            app.clone(),
                            app.state::<UpdateState>(),
                            version,
                        )
                        .await
                        {
                            let deferred = error.starts_with("Автообновление отложено:");
                            app.state::<UpdateState>().change(&app, |s| {
                                s.phase = if deferred { "deferred" } else { "error" }.into();
                                s.error = if deferred { None } else { Some(error) };
                            });
                            if !deferred {
                                failures = failures.saturating_add(1);
                                next_check = Instant::now()
                                    + Duration::from_secs(crate::update_journal::retry_seconds(
                                        failures,
                                    ));
                            }
                        }
                    }
                }
            }
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    });
}

/// Enrol only the installed current-user binary.  Debug/QA profiles and a
/// nonstandard data directory never create persistent OS tasks.
pub fn enroll_windows_task(app: AppHandle) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        if config().is_err() {
            return;
        }
        // A production launcher may explicitly pass the standard data path;
        // compare the resolved target instead of treating that as a QA marker.
        let Ok(standard_data) = app.path().app_data_dir() else {
            return;
        };
        #[cfg(debug_assertions)]
        if std::env::var_os("HANNI_MVP_DATA_DIR")
            .is_some_and(|value| std::path::PathBuf::from(value) != standard_data)
        {
            return;
        }
        let Ok(local) = std::env::var("LOCALAPPDATA") else {
            return;
        };
        let expected = std::path::PathBuf::from(local)
            .join("Programs")
            .join("Hanni MVP")
            .join("hanni-mvp.exe");
        let Ok(exe) = std::env::current_exe() else {
            return;
        };
        if exe != expected || !expected.is_file() {
            return;
        }
        let Some(system_root) = std::env::var_os("SystemRoot") else {
            return;
        };
        let scheduler = std::path::PathBuf::from(system_root)
            .join("System32")
            .join("schtasks.exe");
        let task = "Hanni MVP automatic updates";
        let command = format!("\"{}\" --update-background", expected.display());
        for (suffix, schedule, extra) in [
            ("", "ONLOGON", Vec::<&str>::new()),
            (" (6h)", "HOURLY", vec!["/MO", "6"]),
        ] {
            let mut call = std::process::Command::new(&scheduler);
            call.args([
                "/Create",
                "/TN",
                &format!("{task}{suffix}"),
                "/TR",
                &command,
                "/SC",
                schedule,
                "/RL",
                "LIMITED",
                "/IT",
                "/F",
            ]);
            call.args(extra);
            let succeeded = call
                .creation_flags(0x08000000)
                .output()
                .is_ok_and(|result| result.status.success()); // CREATE_NO_WINDOW
            if !succeeded {
                app.state::<UpdateState>().change(&app, |s| {
                    s.background_error = Some(
                        "Windows не разрешила включить проверки при закрытом приложении.".into(),
                    );
                });
            }
        }
    }
}
#[tauri::command]
pub fn mvp_update_status(app: AppHandle, state: State<'_, UpdateState>) -> UpdateStatus {
    #[cfg(target_os = "android")]
    {
        use hanni_mvp_android_installer::{AndroidInstallerExt, InstallStatus};
        if let Ok(result) = app.android_installer().get_install_status() {
            state.change(&app, |s| {
                // Reconciliation clears the persisted permission status when
                // the owner grants Android's one-time install permission.
                if result.status == InstallStatus::Idle && s.phase == "permission_required" {
                    s.phase = "idle".into();
                    s.error = None;
                    return;
                }
                // A callback from a previous version must not hide a newer feed.
                if matches!(
                    result.status,
                    InstallStatus::Success | InstallStatus::Idle | InstallStatus::Unsupported
                ) {
                    return;
                }
                if matches!(s.phase.as_str(), "checking" | "downloading") {
                    return;
                }
                if result.status == InstallStatus::Failure
                    && matches!(
                        s.phase.as_str(),
                        "available" | "prepared" | "deferred" | "current"
                    )
                {
                    return;
                }
                s.phase = match result.status {
                    InstallStatus::Installing => "installing",
                    InstallStatus::PendingUserAction => "confirmation_required",
                    InstallStatus::PermissionRequired => "permission_required",
                    InstallStatus::Failure => "error",
                    _ => return,
                }
                .into();
                if let Some(code) = result.version_code.filter(|c| *c > 0) {
                    s.version = Some(format!(
                        "{}.{}.{}",
                        code / 1_000_000,
                        (code / 1000) % 1000,
                        code % 1000
                    ));
                }
                if result.status == InstallStatus::Failure {
                    s.error = Some("Android не завершил установку. Повторим позже.".into());
                }
            });
        }
    }
    state.snapshot(&app)
}

/// Records a short-lived renderer lease for automatic installation.  An
/// interactive renderer must clear it whenever an editor, dialog, or active
/// timer is present.  This does not affect the explicit Settings action.
#[tauri::command]
pub fn mvp_update_activity(state: State<'_, UpdateState>, activity: UpdateActivity) {
    state.report_activity(activity, Instant::now());
}

fn auto_install_allowed(app: &AppHandle, state: &UpdateState) -> Result<(), String> {
    #[cfg(not(target_os = "android"))]
    if let Some(window) = app.get_webview_window("main") {
        let visible = window
            .is_visible()
            .map_err(|_| "Не удалось проверить окно приложения.")?;
        let minimized = window
            .is_minimized()
            .map_err(|_| "Не удалось проверить окно приложения.")?;
        let focused = window
            .is_focused()
            .map_err(|_| "Не удалось проверить окно приложения.")?;
        if focused || (visible && !minimized) {
            return Err("Автообновление отложено: окно приложения активно.".into());
        }
    } else {
        // The scheduled runner has no renderer and has already acquired the
        // same-profile instance lock during setup.
        return Ok(());
    }
    let lease = state
        .ui_safe
        .lock()
        .map_err(|_| "Не удалось проверить состояние приложения.")?;
    if lease
        .as_ref()
        .is_none_or(|lease| !lease.eligible_at(Instant::now()))
    {
        return Err("Автообновление отложено: приложение ещё может быть занято.".into());
    }
    let app_state = app.state::<crate::AppState>();
    let conn = app_state
        .0
        .lock()
        .map_err(|_| "Не удалось проверить активную задачу.")?;
    let active: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM timeline_blocks WHERE is_active=1)",
            [],
            |row| row.get(0),
        )
        .map_err(|_| "Не удалось проверить активную задачу.")?;
    if active {
        return Err("Автообновление отложено: идёт активная задача.".into());
    }
    Ok(())
}

/// The unattended foreground path is deliberately narrower than the manual
/// action: it needs a fresh hidden/safe renderer lease and no active timer.
#[tauri::command(rename_all = "camelCase")]
pub async fn mvp_update_auto_install(
    app: AppHandle,
    state: State<'_, UpdateState>,
    expected_version: String,
) -> Result<UpdateStatus, String> {
    auto_install_allowed(&app, state.inner())?;
    install_update(app, state, expected_version, true).await
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

pub(crate) async fn install_update(
    app: AppHandle,
    state: State<'_, UpdateState>,
    expected_version: String,
    automatic: bool,
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
    let (_, metadata_path) = prepared_paths(&app, &candidate.version)?;
    let attempt_path = metadata_path.with_file_name("attempt.json");
    if automatic
        && !crate::update_journal::allowed(
            &attempt_path,
            &candidate.version,
            &candidate.package.sha256,
            crate::update_journal::now(),
        )?
    {
        return Err(
            "Предыдущая установка не завершилась. Следующая автоматическая попытка будет позже."
                .into(),
        );
    }
    let result: Result<UpdateStatus, String> = async {
        let (feed, token) = config()?;
        let url = package_url(&feed, &candidate.package.url)?;
        state.change(&app, |s| {
            s.phase = "downloading".into();
            s.error = None;
            s.downloaded = 0;
        });
        let bytes = if let Ok(Some(bytes)) = read_prepared(&app, &candidate) {
            state.change(&app, |s| s.downloaded = candidate.package.size);
            bytes
        } else {
            let mut last = 0;
            let bytes = fetch(url, token, candidate.package.size, |received| {
                if received - last >= 256 * 1024 || received == candidate.package.size {
                    last = received;
                    state.change(&app, |s| s.downloaded = received);
                }
            })
            .await?;
            verify(&bytes, &candidate.package, PUBLIC_KEY)?;
            bytes
        };
        // Consistent backup before either platform installer may stop the process.
        crate::create_backup(app.clone(), app.state::<crate::AppState>())?;
        if automatic {
            // Network and backup can take time; never rely on the lease checked
            // before downloading.
            auto_install_allowed(&app, state.inner())?;
        }
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
            if automatic {
                auto_install_allowed(&app, state.inner())?;
            }
            crate::update_journal::record(
                &attempt_path,
                &candidate.version,
                &candidate.package.sha256,
                crate::update_journal::now(),
            )?;
            let result = app
                .android_installer()
                .install_verified(InstallVerifiedRequest {
                    path: path.to_string_lossy().into_owned(),
                    expected_version_code: candidate.package.version_code.unwrap(),
                    expected_sha256: candidate.package.sha256.to_ascii_lowercase(),
                    automatic,
                })?;
            state.change(&app, |s| {
                s.phase = match result {
                    InstallStatus::Launched => "installer_opened",
                    InstallStatus::PermissionRequired => "permission_required",
                    InstallStatus::Unsupported => "manual_required",
                    InstallStatus::Installing => "installing",
                    InstallStatus::PendingUserAction => "confirmation_required",
                    InstallStatus::Success => "current",
                    InstallStatus::Failure => "error",
                    InstallStatus::Idle => "idle",
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
            let update = update.restart_after_install(!automatic);
            if automatic {
                auto_install_allowed(&app, state.inner())?;
            }
            if update.version != candidate.version
                || update.signature != candidate.package.signature
                || update.download_url.as_str() != candidate.package.url
            {
                return Err("Выпуск изменился. Повтори проверку.".into());
            }
            state.change(&app, |s| s.phase = "installer_opened".into());
            crate::update_journal::record(
                &attempt_path,
                &candidate.version,
                &candidate.package.sha256,
                crate::update_journal::now(),
            )?;
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

#[tauri::command(rename_all = "camelCase")]
pub async fn mvp_update_install(
    app: AppHandle,
    state: State<'_, UpdateState>,
    expected_version: String,
) -> Result<UpdateStatus, String> {
    install_update(app, state, expected_version, false).await
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

/// Android owns the final confirmation.  This command is intentionally a
/// no-op unless its persisted package-installer session asked for user action.
#[tauri::command]
pub fn mvp_update_confirm(
    app: AppHandle,
    state: State<'_, UpdateState>,
) -> Result<UpdateStatus, String> {
    #[cfg(target_os = "android")]
    {
        use hanni_mvp_android_installer::{AndroidInstallerExt, InstallStatus};
        let installer = app.android_installer();
        let current = installer.get_install_status()?;
        if current.status != InstallStatus::PendingUserAction {
            return Err("Подтверждение обновления сейчас не требуется.".into());
        }
        let opened = installer.open_pending_user_action()?;
        state.change(&app, |s| {
            s.phase = match opened {
                InstallStatus::PendingUserAction => "confirmation_required",
                InstallStatus::Installing => "installing",
                _ => "installer_opened",
            }
            .into()
        });
    }
    #[cfg(not(target_os = "android"))]
    let _ = &state;
    Ok(state.snapshot(&app))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn returning_to_editor_or_missing_heartbeat_restarts_safe_wait() {
        let state = UpdateState::default();
        let now = Instant::now();
        let report = |safe, hidden, seconds| {
            state.report_activity(
                UpdateActivity {
                    safe_to_install: safe,
                    hidden,
                },
                now + Duration::from_secs(seconds),
            )
        };
        report(true, true, 0);
        assert!(!state
            .ui_safe
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .eligible_at(now + Duration::from_secs(29)));
        report(true, true, 30);
        assert!(state
            .ui_safe
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .eligible_at(now + Duration::from_secs(30)));
        report(false, true, 31);
        assert!(state.ui_safe.lock().unwrap().is_none());
        report(true, true, 32);
        assert!(!state
            .ui_safe
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .eligible_at(now + Duration::from_secs(33)));
        // A renderer frozen for over 90s cannot restore its old permission.
        report(true, true, 123);
        assert!(!state
            .ui_safe
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .eligible_at(now + Duration::from_secs(123)));
        report(true, false, 124);
        assert!(state.ui_safe.lock().unwrap().is_none());
    }
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

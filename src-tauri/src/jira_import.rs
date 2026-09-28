//! Jira titles and status names only. Source IDs are hashed; descriptions,
//! comments, source keys, links and raw IDs never enter storage or sync.
//! Connection settings and import bookkeeping are device-local. Credentials
//! use a separate OS-secret slot and never enter SQLite or synchronization.
use crate::mvp_sync::secrets;
use crate::task_attributes as attributes;
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, MutexGuard, OnceLock, PoisonError, TryLockError,
    },
    time::Duration,
};
use tauri::Manager;

/// The phone never holds the token; it gets the tasks through the sync.
const SUPPORTED: bool = cfg!(not(any(target_os = "android", target_os = "ios")));
const ID_PREFIX: &str = "jira:";
const SITE_KEY: &str = "jira_import_site";
const PROJECT_KEY: &str = "jira_import_project";
const ENABLED_KEY: &str = "jira_import_enabled";
const TOKEN_MODE_KEY: &str = "jira_import_token_mode";
/// Automatic imports run at most this often; failures back off up to the maximum.
const INTERVAL_MINUTES: i64 = 15;
const MAX_BACKOFF_MINUTES: i64 = 240;
const PAGE_SIZE: usize = 100;
/// Issues read per import. A larger result is cut and reported as truncated.
const MAX_ISSUES: usize = 500;
const MAX_PAGES: usize = 20;
const MAX_BODY: u64 = 4 * 1024 * 1024;
const MAX_TITLE: usize = 500;

fn storage(_: impl std::fmt::Display) -> String {
    "jira_storage_failed".into()
}
fn lock(db: &Mutex<Connection>) -> Result<MutexGuard<'_, Connection>, String> {
    db.lock().map_err(|_| "jira_storage_failed".into())
}
fn stamp(time: DateTime<Utc>) -> String {
    time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn initialize(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS jira_import_state (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), last_attempt TEXT, last_success TEXT,
        last_count INTEGER, last_error TEXT, failures INTEGER NOT NULL DEFAULT 0, next_attempt TEXT,
        truncated INTEGER NOT NULL DEFAULT 0);
        INSERT OR IGNORE INTO jira_import_state(singleton) VALUES(1);
        CREATE TABLE IF NOT EXISTS jira_import_links (
        item_id TEXT PRIMARY KEY, last_summary TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS jira_create_requests (
        request_id TEXT PRIMARY KEY, scope_hash TEXT NOT NULL, binding_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('prepared','pending','done','acknowledged')),
        fingerprint TEXT, title TEXT, item_id TEXT, status TEXT, created_at TEXT NOT NULL);
        CREATE UNIQUE INDEX IF NOT EXISTS jira_create_unresolved
        ON jira_create_requests(scope_hash) WHERE state IN ('pending','done');",
    )
    .map_err(storage)
}

// ---- Settings and credential ----

fn valid_jira_host(value: &str) -> bool {
    value.len() <= 253
        && value.strip_suffix(".atlassian.net").is_some_and(|name| {
            !name.is_empty()
                && name.split('.').map(str::as_bytes).all(|label| {
                    (1..=63).contains(&label.len())
                        && label[0] != b'-'
                        && label[label.len() - 1] != b'-'
                        && label
                            .iter()
                            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
                })
        })
}

/// Jira project key: an uppercase letter, then `A-Z 0-9 _`, 1–20 characters.
fn valid_jira_project(value: &str) -> bool {
    let bytes = value.as_bytes();
    (1..=20).contains(&bytes.len())
        && bytes[0].is_ascii_uppercase()
        && bytes
            .iter()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || *b == b'_')
}

/// Accepts a Jira Cloud site `example.atlassian.net`, optionally typed with
/// `https://` and a trailing `/`.
fn normalize_site(raw: &str) -> Result<String, String> {
    let value = raw.trim();
    let value = match value.get(..8) {
        Some(scheme) if scheme.eq_ignore_ascii_case("https://") => &value[8..],
        _ => value,
    };
    let value = value
        .strip_suffix('/')
        .unwrap_or(value)
        .to_ascii_lowercase();
    if valid_jira_host(&value) {
        Ok(value)
    } else {
        Err("jira_site_invalid".into())
    }
}
fn normalize_project(raw: &str) -> Result<String, String> {
    let value = raw.trim().to_ascii_uppercase();
    if valid_jira_project(&value) {
        Ok(value)
    } else {
        Err("jira_project_invalid".into())
    }
}
/// Basic authentication forbids `:` in the user id.
fn valid_email(value: &str) -> bool {
    (3..=254).contains(&value.len())
        && value
            .split_once('@')
            .is_some_and(|(user, domain)| !user.is_empty() && !domain.is_empty())
        && !value
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || c == ':')
}
fn valid_token(value: &str) -> bool {
    (1..=1024).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_graphic())
}

#[derive(Clone, Copy, Default, PartialEq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TokenMode {
    #[default]
    Scoped,
    Classic,
}
impl TokenMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Scoped => "scoped",
            Self::Classic => "classic",
        }
    }
}

/// The token together with the site it was entered for. Never logged or
/// returned to the interface.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Credential {
    v: u8,
    token_mode: TokenMode,
    site: String,
    email: String,
    token: String,
}
const CREDENTIAL_VERSION: u8 = 3;
impl Credential {
    /// An unreadable stored value, including a format without the site, means
    /// the token has to be entered again.
    fn parse(raw: &str) -> Result<Self, String> {
        serde_json::from_str::<Self>(raw)
            .ok()
            .filter(|value| {
                value.v == CREDENTIAL_VERSION
                    && valid_jira_host(&value.site)
                    && valid_email(&value.email)
                    && valid_token(&value.token)
            })
            .ok_or_else(|| "jira_token_unavailable".into())
    }
}

/// Secret-store failures, named for the interface. Access is noninteractive; a
/// failed read pauses the import and nothing is deleted automatically.
fn store_error(code: String) -> String {
    if code.ends_with("_write_failed") || code.ends_with("_verify_failed") {
        "jira_token_write_failed".into()
    } else if code == "mvp_sync_platform_unsupported" {
        "jira_unsupported".into()
    } else {
        "jira_token_unavailable".into()
    }
}

#[derive(Clone, PartialEq)]
struct Config {
    site: String,
    token_mode: TokenMode,
    project: String,
    enabled: bool,
}
impl Config {
    fn ready(&self) -> bool {
        self.enabled && !self.site.is_empty() && !self.project.is_empty()
    }
}
fn setting(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row("SELECT value FROM app_settings WHERE key=?1", [key], |r| {
        r.get(0)
    })
    .optional()
    .map_err(storage)
}
fn put_setting(conn: &Connection, key: &str, value: &str, now: &str) -> Result<(), String> {
    conn.execute("INSERT INTO app_settings(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at", params![key, value, now])
        .map(|_| ())
        .map_err(storage)
}
fn read_config(conn: &Connection) -> Result<Config, String> {
    let token_mode = match setting(conn, TOKEN_MODE_KEY)?.as_deref() {
        None | Some("scoped") => TokenMode::Scoped,
        Some("classic") => TokenMode::Classic,
        _ => return Err("jira_token_mode_invalid".into()),
    };
    Ok(Config {
        token_mode,
        site: setting(conn, SITE_KEY)?
            .filter(|v| valid_jira_host(v))
            .unwrap_or_default(),
        project: setting(conn, PROJECT_KEY)?
            .filter(|v| valid_jira_project(v))
            .unwrap_or_default(),
        enabled: setting(conn, ENABLED_KEY)?.as_deref() == Some("1"),
    })
}
/// A saved configuration is due at once and starts without an old error;
/// another site or project also starts without the previous counts.
fn save_config(
    conn: &Connection,
    site: &str,
    project: &str,
    token_mode: TokenMode,
    now: &str,
) -> Result<(), String> {
    let previous = read_config(conn)?;
    put_setting(conn, SITE_KEY, site, now)?;
    put_setting(conn, PROJECT_KEY, project, now)?;
    put_setting(conn, TOKEN_MODE_KEY, token_mode.as_str(), now)?;
    put_setting(conn, ENABLED_KEY, "1", now)?;
    let reset = if previous.site != site
        || previous.project != project
        || previous.token_mode != token_mode
    {
        "UPDATE jira_import_state SET last_attempt=NULL,last_success=NULL,last_count=NULL,truncated=0,last_error=NULL,failures=0,next_attempt=NULL WHERE singleton=1"
    } else {
        "UPDATE jira_import_state SET last_error=NULL,failures=0,next_attempt=NULL WHERE singleton=1"
    };
    conn.execute(reset, []).map(|_| ()).map_err(storage)
}
/// Stops importing; site and project stay for a later reconnection and every
/// imported task stays as it is.
fn disable_config(conn: &Connection, now: &str) -> Result<(), String> {
    put_setting(conn, ENABLED_KEY, "0", now)?;
    conn.execute("UPDATE jira_import_state SET last_error=NULL,failures=0,next_attempt=NULL WHERE singleton=1", [])
        .map(|_| ())
        .map_err(storage)
}

/// The secret store behind the credential; tests use an in-memory one.
trait Vault: Send + Sync {
    fn read(&self) -> Result<Option<String>, String>;
    fn write(&self, raw: &str) -> Result<(), String>;
    fn delete(&self) -> Result<(), String>;
}
struct SystemVault(PathBuf);
impl Vault for SystemVault {
    fn read(&self) -> Result<Option<String>, String> {
        secrets::read_from(&secrets::JIRA, &self.0)
    }
    fn write(&self, raw: &str) -> Result<(), String> {
        secrets::write_to(&secrets::JIRA, &self.0, raw)
    }
    fn delete(&self) -> Result<(), String> {
        secrets::delete_from(&secrets::JIRA, &self.0)
    }
}

pub struct Runtime {
    vault: Arc<dyn Vault>,
    credential: Mutex<Option<Result<Option<Credential>, String>>>,
    import: Mutex<()>,
    /// Bumped whenever the credential is saved or removed. A request that
    /// started with an older credential does not store its result.
    generation: AtomicU64,
}
impl Runtime {
    pub fn new(database_path: PathBuf) -> Self {
        Self::with_vault(Arc::new(SystemVault(database_path)))
    }
    fn with_vault(vault: Arc<dyn Vault>) -> Self {
        Self {
            vault,
            credential: Mutex::new(None),
            import: Mutex::new(()),
            generation: AtomicU64::new(0),
        }
    }
    fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }
    fn read_store(&self) -> Result<Option<Credential>, String> {
        self.vault
            .read()
            .map_err(store_error)
            .and_then(|raw| raw.as_deref().map(Credential::parse).transpose())
    }
    /// As for the sync key, a read (or its failure) is kept until the token is
    /// saved again or the app restarts, so periodic ticks never retry the store.
    fn credential(&self) -> Result<Option<Credential>, String> {
        let mut cache = self.credential.lock().map_err(|_| "jira_import_busy")?;
        if let Some(value) = cache.as_ref() {
            return value.clone();
        }
        let value = self.read_store();
        *cache = Some(value.clone());
        value
    }
    /// An explicit save retries the store. Without a new token the stored one is
    /// kept, which requires that it is still readable and was entered for this
    /// site: a saved token is never sent to another site.
    fn save_credential(
        &self,
        site: String,
        email: String,
        token: Option<String>,
        token_mode: TokenMode,
    ) -> Result<(), String> {
        let mut cache = self.credential.lock().map_err(|_| "jira_import_busy")?;
        let token = match token {
            Some(token) => token,
            None => {
                let stored = self.read_store();
                *cache = Some(stored.clone());
                match stored? {
                    Some(current) if current.site != site => {
                        return Err("jira_token_required_for_site".into())
                    }
                    Some(current) if current.token_mode != token_mode => {
                        return Err("jira_token_required_for_mode".into())
                    }
                    Some(current) if current.email == email => return Ok(()),
                    Some(current) => current.token,
                    None => return Err("jira_token_required".into()),
                }
            }
        };
        self.generation.fetch_add(1, Ordering::SeqCst);
        let credential = Credential {
            v: CREDENTIAL_VERSION,
            token_mode,
            site,
            email,
            token,
        };
        let raw = serde_json::to_string(&credential).map_err(|_| "jira_token_invalid")?;
        match self.vault.write(&raw) {
            Ok(()) => {
                *cache = Some(Ok(Some(credential)));
                Ok(())
            }
            Err(error) => {
                *cache = None;
                Err(store_error(error))
            }
        }
    }
    /// A failed removal leaves the cache empty, so the status reads the store
    /// again and «Отключить» can be retried.
    fn delete_credential(&self) -> Result<(), String> {
        let mut cache = self.credential.lock().map_err(|_| "jira_import_busy")?;
        self.generation.fetch_add(1, Ordering::SeqCst);
        *cache = None;
        self.vault
            .delete()
            .map_err(|_| "jira_token_delete_failed".to_string())?;
        *cache = Some(Ok(None));
        Ok(())
    }
}

// ---- Jira response ----

#[derive(Clone)]
struct Issue {
    id: String,
    // Transient membership proof from the current top-level issue key; never stored.
    project: Option<String>,
    status: String,
    /// The cleaned summary: the task title.
    title: String,
}
struct Page {
    issues: Vec<Issue>,
    next: Option<String>,
}
struct Fetched {
    issues: Vec<Issue>,
    truncated: bool,
}
#[derive(Debug, PartialEq)]
struct Failure {
    code: String,
    retry_after: Option<i64>,
}
fn failure(code: &str) -> Failure {
    Failure {
        code: code.into(),
        retry_after: None,
    }
}

#[derive(Deserialize)]
struct PageBody {
    issues: Vec<IssueBody>,
    #[serde(rename = "nextPageToken", default)]
    next_page_token: Option<String>,
    #[serde(rename = "isLast", default)]
    is_last: Option<bool>,
}
#[derive(Deserialize)]
struct IssueBody {
    id: String,
    #[serde(default)]
    key: Option<String>,
    #[serde(default)]
    fields: Option<FieldsBody>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FieldsBody {
    #[serde(default)]
    summary: Option<String>,
    status: StatusBody,
}

#[derive(Deserialize)]
struct StatusBody {
    id: String,
    name: String,
}
fn valid_remote_id(value: &str) -> bool {
    (1..=20).contains(&value.len()) && value.bytes().all(|c| c.is_ascii_digit())
}
fn status_name(status: StatusBody) -> Result<String, Failure> {
    if !valid_remote_id(&status.id)
        || status.name.trim().is_empty()
        || status.name.chars().count() > 200
        || status.name.chars().any(char::is_control)
    {
        return Err(failure("jira_response_invalid"));
    }
    Ok(status.name)
}

/// Empty titles fail closed instead of substituting source metadata.
fn clean_title(summary: &str) -> Result<String, Failure> {
    let line: String = summary
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let title: String = line.trim().chars().take(MAX_TITLE).collect();
    let title = title.trim_end();
    if title.is_empty() {
        Err(failure("jira_response_invalid"))
    } else {
        Ok(title.to_owned())
    }
}

fn decode_issue(issue: IssueBody) -> Result<Issue, Failure> {
    if !valid_remote_id(&issue.id) {
        return Err(failure("jira_response_invalid"));
    }
    let fields = issue
        .fields
        .ok_or_else(|| failure("jira_response_invalid"))?;
    let project = issue
        .key
        .as_deref()
        .and_then(|key| key.rsplit_once('-'))
        .filter(|(project, number)| valid_jira_project(project) && valid_remote_id(number))
        .map(|(project, _)| project.to_owned());
    Ok(Issue {
        id: issue.id,
        project,
        title: clean_title(&fields.summary.unwrap_or_default())?,
        status: status_name(fields.status)?,
    })
}

/// A page of the enhanced JQL search. `nextPageToken` is absent on the last
/// page; `isLast` confirms it.
fn parse_page(body: &[u8]) -> Result<Page, Failure> {
    let page: PageBody =
        serde_json::from_slice(body).map_err(|_| failure("jira_response_invalid"))?;
    let issues = page
        .issues
        .into_iter()
        .map(decode_issue)
        .collect::<Result<Vec<_>, _>>()?;
    let next = page
        .next_page_token
        .filter(|token| !token.is_empty() && page.is_last != Some(true));
    if next.as_ref().is_some_and(|token| token.len() > 4096) {
        return Err(failure("jira_response_invalid"));
    }
    Ok(Page { issues, next })
}

/// Follows `nextPageToken` up to the issue cap. A repeated token is a broken
/// response, not a reason to loop.
fn collect(
    mut page: impl FnMut(Option<&str>) -> Result<Page, Failure>,
) -> Result<Fetched, Failure> {
    let mut issues: Vec<Issue> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut token: Option<String> = None;
    for _ in 0..MAX_PAGES {
        let current = page(token.as_deref())?;
        for issue in current.issues {
            if seen.insert(issue.id.clone()) {
                issues.push(issue);
            }
        }
        if issues.len() >= MAX_ISSUES {
            let truncated = issues.len() > MAX_ISSUES || current.next.is_some();
            issues.truncate(MAX_ISSUES);
            return Ok(Fetched { issues, truncated });
        }
        match current.next {
            None => {
                return Ok(Fetched {
                    issues,
                    truncated: false,
                })
            }
            Some(next) if token.as_deref() == Some(next.as_str()) => {
                return Err(failure("jira_response_invalid"))
            }
            Some(next) => token = Some(next),
        }
    }
    Ok(Fetched {
        issues,
        truncated: true,
    })
}

/// Distinct codes for the interface. `Retry-After` in seconds is honoured.
fn http_failure(status: u16, retry_after: Option<&str>) -> Failure {
    let code = match status {
        300..=399 => "jira_redirected",
        400 => "jira_bad_request",
        401 => "jira_unauthorized",
        403 => "jira_forbidden",
        404 => "jira_not_found",
        429 => "jira_rate_limited",
        500..=599 => "jira_server_error",
        _ => "jira_http_error",
    };
    let retry_after = retry_after
        .and_then(|value| value.trim().parse::<i64>().ok())
        .filter(|value| *value >= 0);
    Failure {
        code: code.into(),
        retry_after: if matches!(status, 429 | 503) {
            retry_after
        } else {
            None
        },
    }
}

fn jql(project: &str) -> String {
    format!("project = \"{project}\" ORDER BY updated DESC")
}

/// Hardened like the sync transport: short timeouts, HTTPS only, no redirects.
fn client() -> Result<&'static reqwest::blocking::Client, Failure> {
    static CLIENT: OnceLock<Option<reqwest::blocking::Client>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::blocking::Client::builder()
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(25))
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never())
                .https_only(true)
                .build()
                .ok()
        })
        .as_ref()
        .ok_or_else(|| failure("jira_network_unavailable"))
}

// Atlassian documents tenant_info and scoped-token routing separately. Discovery
// never receives credentials; only the subsequent search request authenticates.
fn tenant_request(
    client: &reqwest::blocking::Client,
    site: &str,
) -> Result<reqwest::blocking::Request, Failure> {
    if !valid_jira_host(site) {
        return Err(failure("jira_site_invalid"));
    }
    client
        .get(format!("https://{site}/_edge/tenant_info"))
        .header(reqwest::header::ACCEPT, "application/json")
        .build()
        .map_err(|_| failure("jira_network_unavailable"))
}

#[derive(Deserialize)]
struct TenantInfo {
    #[serde(rename = "cloudId")]
    cloud_id: String,
}
fn parse_cloud_id(body: &[u8]) -> Result<String, Failure> {
    let tenant: TenantInfo =
        serde_json::from_slice(body).map_err(|_| failure("jira_cloud_id_invalid"))?;
    uuid::Uuid::parse_str(&tenant.cloud_id)
        .map(|id| id.hyphenated().to_string())
        .map_err(|_| failure("jira_cloud_id_invalid"))
}

fn api_base(
    config: &Config,
    credential: &Credential,
    cloud_id: Option<&str>,
) -> Result<String, Failure> {
    if !valid_jira_project(&config.project) {
        return Err(failure("jira_project_invalid"));
    }
    if !valid_jira_host(&credential.site) || config.site != credential.site {
        return Err(failure("jira_token_required_for_site"));
    }
    if config.token_mode != credential.token_mode {
        return Err(failure("jira_token_required_for_mode"));
    }
    Ok(match credential.token_mode {
        TokenMode::Classic => format!("https://{}", credential.site),
        TokenMode::Scoped => {
            let id = cloud_id
                .and_then(|id| uuid::Uuid::parse_str(id).ok())
                .ok_or_else(|| failure("jira_cloud_id_invalid"))?;
            format!("https://api.atlassian.com/ex/jira/{}", id.hyphenated())
        }
    })
}

fn search_request(
    client: &reqwest::blocking::Client,
    config: &Config,
    credential: &Credential,
    cloud_id: Option<&str>,
    page_token: Option<&str>,
) -> Result<reqwest::blocking::Request, Failure> {
    let base = api_base(config, credential, cloud_id)?;
    let mut url = reqwest::Url::parse(&format!("{base}/rest/api/3/search/jql"))
        .map_err(|_| failure("jira_site_invalid"))?;
    {
        let mut query = url.query_pairs_mut();
        query
            .append_pair("jql", &jql(&config.project))
            .append_pair("fields", "summary,status")
            .append_pair("maxResults", &PAGE_SIZE.to_string());
        if let Some(token) = page_token {
            query.append_pair("nextPageToken", token);
        }
    }
    client
        .get(url)
        .basic_auth(&credential.email, Some(&credential.token))
        .header(reqwest::header::ACCEPT, "application/json")
        .build()
        .map_err(|_| failure("jira_network_unavailable"))
}

fn read_response(
    client: &reqwest::blocking::Client,
    request: reqwest::blocking::Request,
    limit: u64,
) -> Result<Vec<u8>, Failure> {
    use std::io::Read;
    let response = client.execute(request).map_err(|error| {
        failure(if error.is_timeout() {
            "jira_timeout"
        } else {
            "jira_network_unavailable"
        })
    })?;
    let status = response.status().as_u16();
    if status != 200 {
        let retry_after = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok());
        return Err(http_failure(status, retry_after));
    }
    let mut body = Vec::new();
    response
        .take(limit + 1)
        .read_to_end(&mut body)
        .map_err(|_| failure("jira_network_unavailable"))?;
    if body.len() as u64 > limit {
        return Err(failure("jira_response_invalid"));
    }
    Ok(body)
}

fn fetch(config: &Config, credential: &Credential) -> Result<Fetched, Failure> {
    let client = client()?;
    let cloud_id = match credential.token_mode {
        TokenMode::Classic => None,
        TokenMode::Scoped => Some(parse_cloud_id(&read_response(
            client,
            tenant_request(client, &credential.site)?,
            4096,
        )?)?),
    };
    collect(|token| {
        let request = search_request(client, config, credential, cloud_id.as_deref(), token)?;
        parse_page(&read_response(client, request, MAX_BODY)?)
    })
}

// ---- Apply ----

fn item_id(site: &str, issue_id: &str) -> String {
    format!(
        "{ID_PREFIX}{}",
        hex::encode(Sha256::digest(format!("{site}\n{issue_id}").as_bytes()))
    )
}

fn new_task_tags() -> String {
    attributes::write("", None, Some("work"))
}

/// Deleted in Cicada and delivered as a sync tombstone: never recreated.
fn deleted_by_sync(conn: &Connection, id: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM mvp_records WHERE id=?1 AND json_extract(data,'$.deleted')=1)",
        [json!(["items", [id]]).to_string()],
        |r| r.get(0),
    )
    .map_err(storage)
}

/// Applies one import in the caller's transaction and returns the number of
/// created or changed tasks. An existing task keeps its status, completion,
/// sphere, process, stage, goal and timers. Its title follows Jira only while
/// it still equals the last imported summary; source metadata is never stored.
/// Jira status names refresh independently, including on closed tasks. Nothing
/// is deleted, and issues missing from the result are not touched. A task from
/// another device (same id, no local link) keeps its local title while adopting
/// the current Jira status. A closed task keeps the summary it was
/// last imported with, so after reopening in Cicada its title follows Jira again.
fn apply(conn: &Connection, site: &str, issues: &[Issue], now: &str) -> Result<usize, String> {
    let mut changed = 0;
    for issue in issues {
        let id = item_id(site, &issue.id);
        let link: Option<String> = conn
            .query_row(
                "SELECT last_summary FROM jira_import_links WHERE item_id=?1",
                [&id],
                |r| r.get(0),
            )
            .optional()
            .map_err(storage)?;
        let row: Option<(String, String, bool, bool, String, String)> = conn
            .query_row(
                "SELECT kind,status,completed,archived,title,tags FROM items WHERE id=?1",
                [&id],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get::<_, i64>(2)? != 0,
                        r.get::<_, i64>(3)? != 0,
                        r.get(4)?,
                        r.get(5)?,
                    ))
                },
            )
            .optional()
            .map_err(storage)?;
        let open = match row {
            // Imported before and deleted since: the deletion stands.
            None if link.is_some() => continue,
            None if deleted_by_sync(conn, &id)? => false,
            None => {
                conn.execute("INSERT INTO items(id,kind,title,notes,date,time,duration_minutes,completed,version,created_at,updated_at,category,color,priority,archived,tags,status) VALUES(?1,'task',?2,'',NULL,NULL,0,0,1,?3,?3,'task','#9B9B9B',0,0,?4,'task')",
                    params![id, issue.title, now, attributes::with_jira_status(&new_task_tags(), &issue.status)]).map_err(storage)?;
                changed += 1;
                true
            }
            Some((kind, status, completed, archived, title, tags)) => {
                let task = kind == "task" && matches!(status.as_str(), "task" | "done");
                let open = task && status == "task" && !completed && !archived;
                let follows = open
                    && link.as_deref().is_some_and(|last| last == title)
                    && title != issue.title;
                let next_title = follows.then_some(&issue.title);
                let next_tags = (task
                    && attributes::jira_status(&tags).as_deref() != Some(issue.status.as_str()))
                .then(|| attributes::with_jira_status(&tags, &issue.status));
                if next_title.is_some() || next_tags.is_some() {
                    changed += conn.execute("UPDATE items SET title=COALESCE(?1,title),tags=COALESCE(?2,tags),version=version+1,updated_at=?3 WHERE id=?4",
                        params![next_title, next_tags, now, id]).map_err(storage)?;
                }
                open
            }
        };
        let link = if open {
            "INSERT INTO jira_import_links(item_id,last_summary) VALUES(?1,?2) ON CONFLICT(item_id) DO UPDATE SET last_summary=excluded.last_summary WHERE last_summary<>excluded.last_summary"
        } else {
            "INSERT OR IGNORE INTO jira_import_links(item_id,last_summary) VALUES(?1,?2)"
        };
        conn.execute(link, params![id, issue.title])
            .map_err(storage)?;
    }
    Ok(changed)
}

// ---- Schedule and state ----

/// 15 minutes after an attempt; after failures 15, 30, 60, 120 and at most 240
/// minutes, and never earlier than Jira's `Retry-After`.
fn next_attempt(now: DateTime<Utc>, failures: i64, retry_after: Option<i64>) -> DateTime<Utc> {
    let minutes = if failures <= 0 {
        INTERVAL_MINUTES
    } else {
        (INTERVAL_MINUTES << (failures - 1).min(4)).min(MAX_BACKOFF_MINUTES)
    };
    let wait = chrono::Duration::minutes(minutes).max(chrono::Duration::seconds(
        retry_after.unwrap_or(0).clamp(0, 86_400),
    ));
    now + wait
}
fn due_at(conn: &Connection) -> Result<Option<DateTime<Utc>>, String> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT next_attempt FROM jira_import_state WHERE singleton=1",
            [],
            |r| r.get(0),
        )
        .map_err(storage)?;
    Ok(raw
        .and_then(|value| DateTime::parse_from_rfc3339(&value).ok())
        .map(|value| value.with_timezone(&Utc)))
}
fn record_success(
    conn: &Connection,
    now: DateTime<Utc>,
    count: usize,
    truncated: bool,
) -> Result<(), String> {
    conn.execute("UPDATE jira_import_state SET last_attempt=?1,last_success=?1,last_count=?2,last_error=NULL,failures=0,next_attempt=?3,truncated=?4 WHERE singleton=1",
        params![stamp(now), count as i64, stamp(next_attempt(now, 0, None)), truncated]).map(|_| ()).map_err(storage)
}
fn record_failure(conn: &Connection, now: DateTime<Utc>, failure: &Failure) -> Result<(), String> {
    let failures: i64 = conn
        .query_row(
            "SELECT failures FROM jira_import_state WHERE singleton=1",
            [],
            |r| r.get(0),
        )
        .map_err(storage)?;
    let failures = failures.saturating_add(1);
    conn.execute("UPDATE jira_import_state SET last_attempt=?1,last_error=?2,failures=?3,next_attempt=?4 WHERE singleton=1",
        params![stamp(now), failure.code, failures, stamp(next_attempt(now, failures, failure.retry_after))]).map(|_| ()).map_err(storage)
}

#[derive(Clone, Copy, PartialEq)]
enum Trigger {
    /// The 60-second tick: at most once per interval, after the backoff.
    Automatic,
    /// «Загрузить сейчас»: bypasses the interval.
    Manual,
}

/// One import. The database lock is not held during the request. The attempt
/// is recorded before it, so a result that cannot be stored never makes every
/// tick call Jira again. The result is stored only when neither the settings
/// nor the credential changed meanwhile.
fn run(
    db: &Mutex<Connection>,
    runtime: &Runtime,
    trigger: Trigger,
    now: DateTime<Utc>,
    fetch: impl FnOnce(&Config, &Credential) -> Result<Fetched, Failure>,
) -> Result<usize, String> {
    let generation = runtime.generation();
    let config = {
        let conn = lock(db)?;
        let config = read_config(&conn)?;
        if !config.ready() {
            return if trigger == Trigger::Manual {
                Err("jira_not_configured".into())
            } else {
                Ok(0)
            };
        }
        if trigger == Trigger::Automatic && due_at(&conn)?.is_some_and(|at| now < at) {
            return Ok(0);
        }
        conn.execute(
            "UPDATE jira_import_state SET last_attempt=?1,next_attempt=?2 WHERE singleton=1",
            params![stamp(now), stamp(next_attempt(now, 0, None))],
        )
        .map_err(storage)?;
        config
    };
    let outcome = match runtime.credential() {
        Ok(Some(credential)) if credential.site != config.site => {
            Err(failure("jira_token_required_for_site"))
        }
        Ok(Some(credential)) if credential.token_mode != config.token_mode => {
            Err(failure("jira_token_required_for_mode"))
        }
        Ok(Some(credential)) => fetch(&config, &credential),
        Ok(None) => Err(failure("jira_token_required")),
        Err(code) => Err(Failure {
            code,
            retry_after: None,
        }),
    };
    let mut conn = lock(db)?;
    match store(&mut conn, runtime, &config, generation, now, outcome) {
        Ok(changed) => Ok(changed),
        Err(code) => {
            // The failed transaction is rolled back; the failure is recorded on its own.
            let _ = record_failure(&conn, now, &failure(&code));
            Err(code)
        }
    }
}
fn store(
    conn: &mut Connection,
    runtime: &Runtime,
    config: &Config,
    generation: u64,
    now: DateTime<Utc>,
    outcome: Result<Fetched, Failure>,
) -> Result<usize, String> {
    let transaction = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(storage)?;
    if read_config(&transaction)? != *config || runtime.generation() != generation {
        return Ok(0);
    }
    let changed = match outcome {
        Ok(fetched) => {
            let changed = apply(&transaction, &config.site, &fetched.issues, &stamp(now))?;
            record_success(&transaction, now, fetched.issues.len(), fetched.truncated)?;
            changed
        }
        Err(failure) => {
            record_failure(&transaction, now, &failure)?;
            0
        }
    };
    transaction.commit().map_err(storage)?;
    Ok(changed)
}

/// A manual import waits for a running one, so the import right after saving
/// a new token uses it; an automatic tick skips while one runs.
fn import_once(
    runtime: &Runtime,
    db: &Mutex<Connection>,
    trigger: Trigger,
    fetch: impl FnOnce(&Config, &Credential) -> Result<Fetched, Failure>,
) -> Result<usize, String> {
    let _running = match trigger {
        Trigger::Manual => runtime
            .import
            .lock()
            .unwrap_or_else(PoisonError::into_inner),
        Trigger::Automatic => match runtime.import.try_lock() {
            Ok(guard) => guard,
            Err(TryLockError::Poisoned(guard)) => guard.into_inner(),
            Err(TryLockError::WouldBlock) => return Ok(0),
        },
    };
    run(db, runtime, trigger, Utc::now(), fetch)
}

fn configure(
    runtime: &Runtime,
    db: &Mutex<Connection>,
    site: &str,
    project: &str,
    email: &str,
    token: Option<String>,
    token_mode: TokenMode,
    now: DateTime<Utc>,
) -> Result<(), String> {
    let site = normalize_site(site)?;
    let project = normalize_project(project)?;
    let email = email.trim().to_owned();
    if !valid_email(&email) {
        return Err("jira_email_invalid".into());
    }
    let token = token
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    if token.as_deref().is_some_and(|value| !valid_token(value)) {
        return Err("jira_token_invalid".into());
    }
    runtime.save_credential(site.clone(), email, token, token_mode)?;
    save_config(&*lock(db)?, &site, &project, token_mode, &stamp(now))
}

/// Stops the import first, then removes the token on this explicit request.
fn disable(runtime: &Runtime, db: &Mutex<Connection>, now: DateTime<Utc>) -> Result<(), String> {
    disable_config(&*lock(db)?, &stamp(now))?;
    runtime.delete_credential()
}

/// Never contains the token. A credential read failure is reported as the error.
fn status_value(
    conn: &Connection,
    credential: Option<&Result<Option<Credential>, String>>,
    running: bool,
    changed: usize,
) -> Result<Value, String> {
    let config = read_config(conn)?;
    let mut value = conn.query_row("SELECT last_attempt,last_success,last_count,last_error,next_attempt,truncated FROM jira_import_state WHERE singleton=1", [], |r| {
        Ok(json!({"supported":SUPPORTED,"enabled":config.enabled,"site":config.site,"project":config.project,"tokenMode":config.token_mode,
            "lastAttempt":r.get::<_,Option<String>>(0)?,"lastSuccess":r.get::<_,Option<String>>(1)?,"lastCount":r.get::<_,Option<i64>>(2)?,
            "lastError":r.get::<_,Option<String>>(3)?,"nextAttempt":r.get::<_,Option<String>>(4)?,"truncated":r.get::<_,bool>(5)?,
            "running":running,"changed":changed,"email":"","tokenSaved":false}))
    }).map_err(storage)?;
    match credential {
        Some(Ok(Some(stored))) => {
            value["email"] = json!(stored.email);
            value["tokenSaved"] = json!(true);
        }
        Some(Err(code)) => value["lastError"] = json!(code),
        _ => {}
    }
    Ok(value)
}

/// The credential is read (noninteractively, once per save or app start) once a
/// site was configured, so a token left after a failed removal still shows.
fn status(runtime: &Runtime, db: &Mutex<Connection>, changed: usize) -> Result<Value, String> {
    let config = read_config(&*lock(db)?)?;
    let credential = (config.enabled || !config.site.is_empty()).then(|| runtime.credential());
    let running = runtime.import.try_lock().is_err();
    let conn = lock(db)?;
    status_value(&conn, credential.as_ref(), running, changed)
}

// ---- Explicit Jira task actions ----

#[derive(Clone, Debug, PartialEq, Serialize)]
struct Transition {
    id: String,
    name: String,
    status: String,
}
#[derive(Deserialize)]
struct TransitionsBody {
    transitions: Vec<TransitionBody>,
}
#[derive(Deserialize)]
struct TransitionBody {
    id: String,
    name: String,
    to: StatusBody,
    #[serde(rename = "isAvailable", default)]
    is_available: Option<bool>,
}
fn parse_transitions(body: &[u8]) -> Result<Vec<Transition>, Failure> {
    let body: TransitionsBody =
        serde_json::from_slice(body).map_err(|_| failure("jira_response_invalid"))?;
    if body.transitions.len() > 500 {
        return Err(failure("jira_response_invalid"));
    }
    let mut seen = std::collections::HashSet::new();
    let mut transitions = Vec::new();
    for transition in body.transitions {
        if !valid_remote_id(&transition.id)
            || !seen.insert(transition.id.clone())
            || transition.name.trim().is_empty()
            || transition.name.chars().count() > 200
            || transition.name.chars().any(char::is_control)
        {
            return Err(failure("jira_response_invalid"));
        }
        let status = status_name(transition.to)?;
        if transition.is_available != Some(false) {
            transitions.push(Transition {
                id: transition.id,
                name: transition.name,
                status,
            });
        }
    }
    Ok(transitions)
}

#[derive(Debug, Serialize)]
struct TaskDetails {
    title: String,
    status: String,
    transitions: Vec<Transition>,
    editable: bool,
    changed: usize,
}

enum TaskAction {
    Details,
    Rename {
        title: String,
        expected_title: String,
    },
    Transition {
        id: String,
        expected_status: String,
    },
}
fn valid_edit_title(title: &str) -> bool {
    !title.trim().is_empty()
        && title.chars().count() <= MAX_TITLE
        && !title.chars().any(char::is_control)
}

/// Only typed requests can reach Jira: callers cannot supply a URL or JSON body.
enum IssueRequest<'a> {
    Read,
    Transitions,
    Rename(&'a str),
    Transition(&'a str),
}
fn issue_request(
    client: &reqwest::blocking::Client,
    config: &Config,
    credential: &Credential,
    cloud_id: Option<&str>,
    id: &str,
    operation: IssueRequest<'_>,
) -> Result<reqwest::blocking::Request, Failure> {
    if !valid_remote_id(id) {
        return Err(failure("jira_task_not_found"));
    }
    let base = api_base(config, credential, cloud_id)?;
    let url = format!("{base}/rest/api/3/issue/{id}");
    let request = match operation {
        IssueRequest::Read => client.get(url).query(&[("fields", "summary,status")]),
        IssueRequest::Transitions => client.get(format!("{url}/transitions")),
        IssueRequest::Rename(title) => {
            if !valid_edit_title(title) {
                return Err(failure("jira_title_invalid"));
            }
            client.put(url).json(&json!({"fields":{"summary":title}}))
        }
        IssueRequest::Transition(transition) => {
            if !valid_remote_id(transition) {
                return Err(failure("jira_transition_invalid"));
            }
            client
                .post(format!("{url}/transitions"))
                .json(&json!({"transition":{"id":transition}}))
        }
    };
    request
        .basic_auth(&credential.email, Some(&credential.token))
        .header(reqwest::header::ACCEPT, "application/json")
        .build()
        .map_err(|_| failure("jira_network_unavailable"))
}

/// A dispatched mutation is never retried. A transport failure or uncertain
/// server response cannot tell us whether Jira applied it; only a refresh can.
fn write_status(status: u16, retry_after: Option<&str>) -> Result<(), Failure> {
    match status {
        200 | 204 => Ok(()),
        300..=399 | 400 | 401 | 403 | 404 | 422 | 429 => Err(http_failure(status, retry_after)),
        _ => Err(failure("jira_write_outcome_unknown")),
    }
}
fn write_response(
    client: &reqwest::blocking::Client,
    request: reqwest::blocking::Request,
) -> Result<(), Failure> {
    let response = client
        .execute(request)
        .map_err(|_| failure("jira_write_outcome_unknown"))?;
    write_status(
        response.status().as_u16(),
        response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok()),
    )
}

trait TaskApi {
    fn project_issues(&mut self) -> Result<Fetched, Failure>;
    fn read_issue(&mut self, id: &str) -> Result<Issue, Failure>;
    fn transitions(&mut self, id: &str) -> Result<Vec<Transition>, Failure>;
    fn rename(&mut self, id: &str, title: &str) -> Result<(), Failure>;
    fn transition(&mut self, id: &str, transition: &str) -> Result<(), Failure>;
}
struct HttpTaskApi<'a> {
    client: &'static reqwest::blocking::Client,
    config: &'a Config,
    credential: &'a Credential,
    cloud_id: Option<String>,
}
impl<'a> HttpTaskApi<'a> {
    fn new(config: &'a Config, credential: &'a Credential) -> Result<Self, Failure> {
        let client = client()?;
        let cloud_id = match credential.token_mode {
            TokenMode::Classic => None,
            TokenMode::Scoped => Some(parse_cloud_id(&read_response(
                client,
                tenant_request(client, &credential.site)?,
                4096,
            )?)?),
        };
        Ok(Self {
            client,
            config,
            credential,
            cloud_id,
        })
    }
    fn request(
        &self,
        id: &str,
        operation: IssueRequest<'_>,
    ) -> Result<reqwest::blocking::Request, Failure> {
        issue_request(
            self.client,
            self.config,
            self.credential,
            self.cloud_id.as_deref(),
            id,
            operation,
        )
    }
}
impl TaskApi for HttpTaskApi<'_> {
    fn project_issues(&mut self) -> Result<Fetched, Failure> {
        collect(|token| {
            let request = search_request(
                self.client,
                self.config,
                self.credential,
                self.cloud_id.as_deref(),
                token,
            )?;
            parse_page(&read_response(self.client, request, MAX_BODY)?)
        })
    }
    fn read_issue(&mut self, id: &str) -> Result<Issue, Failure> {
        let body = read_response(self.client, self.request(id, IssueRequest::Read)?, MAX_BODY)?;
        let issue = decode_issue(
            serde_json::from_slice(&body).map_err(|_| failure("jira_response_invalid"))?,
        )?;
        if issue.id != id {
            return Err(failure("jira_response_invalid"));
        }
        Ok(issue)
    }
    fn transitions(&mut self, id: &str) -> Result<Vec<Transition>, Failure> {
        parse_transitions(&read_response(
            self.client,
            self.request(id, IssueRequest::Transitions)?,
            MAX_BODY,
        )?)
    }
    fn rename(&mut self, id: &str, title: &str) -> Result<(), Failure> {
        write_response(self.client, self.request(id, IssueRequest::Rename(title))?)
    }
    fn transition(&mut self, id: &str, transition: &str) -> Result<(), Failure> {
        write_response(
            self.client,
            self.request(id, IssueRequest::Transition(transition))?,
        )
    }
}

fn local_task_exists(conn: &Connection, id: &str) -> Result<bool, String> {
    let valid = id.strip_prefix(ID_PREFIX).is_some_and(|hash| {
        hash.len() == 64
            && hash
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    });
    if !valid {
        return Ok(false);
    }
    conn.query_row("SELECT EXISTS(SELECT 1 FROM items WHERE id=?1 AND kind='task' AND status IN ('task','done'))",
        [id], |r| r.get(0)).map_err(storage)
}

/// Search can lag after a project move. The current issue key from direct GET
/// is checked in memory too; even that cannot make a later mutation atomic.
fn read_project_issue(api: &mut impl TaskApi, id: &str, project: &str) -> Result<Issue, Failure> {
    let issue = api.read_issue(id)?;
    if issue.id != id || issue.project.as_deref() != Some(project) {
        return Err(failure("jira_task_not_found"));
    }
    Ok(issue)
}

fn perform_task(
    db: &Mutex<Connection>,
    config: &Config,
    item: &str,
    action: TaskAction,
    api: &mut impl TaskApi,
) -> Result<TaskDetails, String> {
    if !local_task_exists(&*lock(db)?, item)? {
        return Err("jira_task_not_found".into());
    }
    if matches!(&action, TaskAction::Rename { title, .. } if !valid_edit_title(title)) {
        return Err("jira_title_invalid".into());
    }
    if matches!(&action, TaskAction::Transition { id, .. } if !valid_remote_id(id)) {
        return Err("jira_transition_invalid".into());
    }
    // Resolve the opaque local identity anew inside the configured project. A
    // stale link, a task moved elsewhere or a forged id cannot authorize a write.
    let resolved = api
        .project_issues()
        .map_err(|e| e.code)?
        .issues
        .into_iter()
        .find(|issue| item_id(&config.site, &issue.id) == item)
        .ok_or("jira_task_not_found")?;
    let mut current = read_project_issue(api, &resolved.id, &config.project).map_err(|e| e.code)?;
    let mut transitions = api.transitions(&resolved.id).map_err(|e| e.code)?;
    let wrote = match action {
        TaskAction::Details => false,
        TaskAction::Rename {
            title,
            expected_title,
        } => {
            if current.title != expected_title {
                return Err("jira_task_conflict".into());
            }
            api.rename(&resolved.id, &title).map_err(|e| e.code)?;
            // The API has no conditional compare-and-set for summary. Another
            // Jira editor can still race the check; do not claim atomicity.
            current = read_project_issue(api, &resolved.id, &config.project)
                .map_err(|_| "jira_write_outcome_unknown")?;
            if current.title != title {
                return Err("jira_write_outcome_unknown".into());
            }
            transitions = api
                .transitions(&resolved.id)
                .map_err(|_| "jira_write_outcome_unknown")?;
            true
        }
        TaskAction::Transition {
            id,
            expected_status,
        } => {
            if current.status != expected_status {
                return Err("jira_task_conflict".into());
            }
            let target = transitions
                .iter()
                .find(|transition| transition.id == id)
                .ok_or("jira_transition_invalid")?
                .status
                .clone();
            api.transition(&resolved.id, &id).map_err(|e| e.code)?;
            current = read_project_issue(api, &resolved.id, &config.project)
                .map_err(|_| "jira_write_outcome_unknown")?;
            if current.status != target {
                return Err("jira_write_outcome_unknown".into());
            }
            transitions = api
                .transitions(&resolved.id)
                .map_err(|_| "jira_write_outcome_unknown")?;
            true
        }
    };
    let store = || -> Result<usize, String> {
        let mut conn = lock(db)?;
        let transaction = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        // Local deletion during the network roundtrip must not resurrect a task.
        if !local_task_exists(&transaction, item)? {
            return Err("jira_task_not_found".into());
        }
        let changed = apply(
            &transaction,
            &config.site,
            std::slice::from_ref(&current),
            &stamp(Utc::now()),
        )?;
        transaction.commit().map_err(storage)?;
        Ok(changed)
    };
    let changed = store().map_err(|code| {
        if wrote {
            "jira_write_outcome_unknown".into()
        } else {
            code
        }
    })?;
    Ok(TaskDetails {
        title: current.title,
        status: current.status,
        transitions,
        editable: true,
        changed,
    })
}

fn task_action(app: &tauri::AppHandle, item_id: &str, action: TaskAction) -> Result<Value, String> {
    let runtime = app.state::<Runtime>();
    let _running = runtime
        .import
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    let db = &app.state::<crate::AppState>().0;
    let config = read_config(&*lock(db)?)?;
    if !config.ready() {
        return Err("jira_not_configured".into());
    }
    let credential = runtime.credential()?.ok_or("jira_token_required")?;
    if credential.site != config.site {
        return Err("jira_token_required_for_site".into());
    }
    if credential.token_mode != config.token_mode {
        return Err("jira_token_required_for_mode".into());
    }
    let mut api = HttpTaskApi::new(&config, &credential).map_err(|e| e.code)?;
    serde_json::to_value(perform_task(db, &config, item_id, action, &mut api)?).map_err(storage)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn jira_task_details(app: tauri::AppHandle, item_id: String) -> Result<Value, String> {
    blocking(app, move |app| {
        task_action(app, &item_id, TaskAction::Details)
    })
    .await
}
#[tauri::command(rename_all = "camelCase")]
pub async fn jira_task_rename(
    app: tauri::AppHandle,
    item_id: String,
    title: String,
    expected_title: String,
) -> Result<Value, String> {
    blocking(app, move |app| {
        task_action(
            app,
            &item_id,
            TaskAction::Rename {
                title,
                expected_title,
            },
        )
    })
    .await
}
#[tauri::command(rename_all = "camelCase")]
pub async fn jira_task_transition(
    app: tauri::AppHandle,
    item_id: String,
    transition_id: String,
    expected_status: String,
) -> Result<Value, String> {
    blocking(app, move |app| {
        task_action(
            app,
            &item_id,
            TaskAction::Transition {
                id: transition_id,
                expected_status,
            },
        )
    })
    .await
}

// ---- Explicit Jira creation ----

#[derive(Clone, Debug, PartialEq, Serialize)]
struct CreateIssueType {
    id: String,
    name: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateTypesPage {
    start_at: usize,
    total: usize,
    issue_types: Vec<CreateTypeBody>,
}
#[derive(Deserialize)]
struct CreateTypeBody {
    id: String,
    name: String,
    subtask: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateFieldsPage {
    start_at: usize,
    total: usize,
    fields: Vec<CreateFieldBody>,
}
// Metadata is deliberately projected during deserialization. Names, defaults,
// descriptions, allowedValues and people never become application data.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateFieldBody {
    field_id: String,
    required: bool,
    #[serde(default)]
    has_default_value: bool,
    operations: Vec<String>,
}

fn metadata_next(
    start: usize,
    actual: usize,
    total: usize,
    expected: usize,
) -> Result<Option<usize>, Failure> {
    if start != expected
        || actual > PAGE_SIZE
        || total > PAGE_SIZE * MAX_PAGES
        || start > total
        || actual > total - start
        || (actual == 0 && start < total)
    {
        return Err(failure("jira_response_invalid"));
    }
    Ok((start + actual < total).then_some(start + actual))
}

fn collect_create_types(
    mut fetch: impl FnMut(usize) -> Result<Vec<u8>, Failure>,
) -> Result<Vec<CreateIssueType>, Failure> {
    let mut start = 0;
    let mut types = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for _ in 0..MAX_PAGES {
        let page: CreateTypesPage =
            serde_json::from_slice(&fetch(start)?).map_err(|_| failure("jira_response_invalid"))?;
        let next = metadata_next(page.start_at, page.issue_types.len(), page.total, start)?;
        for row in page.issue_types {
            if !valid_remote_id(&row.id)
                || !seen.insert(row.id.clone())
                || row.name.trim().is_empty()
                || row.name.chars().count() > 200
                || row.name.chars().any(char::is_control)
            {
                return Err(failure("jira_response_invalid"));
            }
            if !row.subtask {
                types.push(CreateIssueType {
                    id: row.id,
                    name: row.name,
                });
            }
        }
        match next {
            Some(next) => start = next,
            None => return Ok(types),
        }
    }
    Err(failure("jira_response_invalid"))
}

fn check_create_fields(
    mut fetch: impl FnMut(usize) -> Result<Vec<u8>, Failure>,
) -> Result<(), Failure> {
    let mut start = 0;
    let mut seen = std::collections::HashSet::new();
    for _ in 0..MAX_PAGES {
        let page: CreateFieldsPage =
            serde_json::from_slice(&fetch(start)?).map_err(|_| failure("jira_response_invalid"))?;
        let next = metadata_next(page.start_at, page.fields.len(), page.total, start)?;
        for row in page.fields {
            if row.field_id.is_empty()
                || row.field_id.len() > 100
                || !seen.insert(row.field_id.clone())
            {
                return Err(failure("jira_response_invalid"));
            }
            if matches!(row.field_id.as_str(), "summary" | "project" | "issuetype") {
                if row.field_id == "summary" && !row.operations.iter().any(|op| op == "set") {
                    return Err(failure("jira_create_required_fields"));
                }
            } else if row.required && !row.has_default_value {
                return Err(failure("jira_create_required_fields"));
            }
        }
        match next {
            Some(next) => start = next,
            None => {
                return if ["summary", "project", "issuetype"]
                    .iter()
                    .all(|field| seen.contains(*field))
                {
                    Ok(())
                } else {
                    Err(failure("jira_create_required_fields"))
                }
            }
        }
    }
    Err(failure("jira_response_invalid"))
}

enum CreateRequest<'a> {
    Types(usize),
    Fields { issue_type: &'a str, start: usize },
    Create { issue_type: &'a str, title: &'a str },
}
fn create_request(
    client: &reqwest::blocking::Client,
    config: &Config,
    credential: &Credential,
    cloud_id: Option<&str>,
    operation: CreateRequest<'_>,
) -> Result<reqwest::blocking::Request, Failure> {
    let base = api_base(config, credential, cloud_id)?;
    let metadata = format!(
        "{base}/rest/api/3/issue/createmeta/{}/issuetypes",
        config.project
    );
    let request =
        match operation {
            CreateRequest::Types(start) => client
                .get(metadata)
                .query(&[("startAt", start), ("maxResults", PAGE_SIZE)]),
            CreateRequest::Fields { issue_type, start } => {
                if !valid_remote_id(issue_type) {
                    return Err(failure("jira_issue_type_invalid"));
                }
                client
                    .get(format!("{metadata}/{issue_type}"))
                    .query(&[("startAt", start), ("maxResults", PAGE_SIZE)])
            }
            CreateRequest::Create { issue_type, title } => {
                if !valid_remote_id(issue_type) {
                    return Err(failure("jira_issue_type_invalid"));
                }
                if !valid_edit_title(title) {
                    return Err(failure("jira_title_invalid"));
                }
                client.post(format!("{base}/rest/api/3/issue")).json(&json!({"fields":{
                "summary":title, "project":{"key":config.project}, "issuetype":{"id":issue_type}
            }}))
            }
        };
    request
        .basic_auth(&credential.email, Some(&credential.token))
        .header(reqwest::header::ACCEPT, "application/json")
        .build()
        .map_err(|_| failure("jira_network_unavailable"))
}

fn create_status(status: u16, retry_after: Option<&str>) -> Result<(), Failure> {
    match status {
        201 => Ok(()),
        300..=399 | 400 | 401 | 403 | 404 | 422 | 429 => Err(http_failure(status, retry_after)),
        _ => Err(failure("jira_create_outcome_unknown")),
    }
}
fn created_id(body: &[u8]) -> Result<String, Failure> {
    #[derive(Deserialize)]
    struct Created {
        id: String,
    }
    let created: Created =
        serde_json::from_slice(body).map_err(|_| failure("jira_create_outcome_unknown"))?;
    if !valid_remote_id(&created.id) {
        return Err(failure("jira_create_outcome_unknown"));
    }
    Ok(created.id)
}

trait CreateApi {
    fn issue_types(&mut self) -> Result<Vec<CreateIssueType>, Failure>;
    fn check_fields(&mut self, issue_type: &str) -> Result<(), Failure>;
    fn create(&mut self, issue_type: &str, title: &str) -> Result<String, Failure>;
    fn created_issue(&mut self, id: &str) -> Result<Issue, Failure>;
}
impl CreateApi for HttpTaskApi<'_> {
    fn issue_types(&mut self) -> Result<Vec<CreateIssueType>, Failure> {
        collect_create_types(|start| {
            read_response(
                self.client,
                create_request(
                    self.client,
                    self.config,
                    self.credential,
                    self.cloud_id.as_deref(),
                    CreateRequest::Types(start),
                )?,
                MAX_BODY,
            )
        })
    }
    fn check_fields(&mut self, issue_type: &str) -> Result<(), Failure> {
        check_create_fields(|start| {
            read_response(
                self.client,
                create_request(
                    self.client,
                    self.config,
                    self.credential,
                    self.cloud_id.as_deref(),
                    CreateRequest::Fields { issue_type, start },
                )?,
                MAX_BODY,
            )
        })
    }
    fn create(&mut self, issue_type: &str, title: &str) -> Result<String, Failure> {
        use std::io::Read;
        let request = create_request(
            self.client,
            self.config,
            self.credential,
            self.cloud_id.as_deref(),
            CreateRequest::Create { issue_type, title },
        )?;
        let response = self
            .client
            .execute(request)
            .map_err(|_| failure("jira_create_outcome_unknown"))?;
        create_status(
            response.status().as_u16(),
            response
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|v| v.to_str().ok()),
        )?;
        let mut body = Vec::new();
        response
            .take(MAX_BODY + 1)
            .read_to_end(&mut body)
            .map_err(|_| failure("jira_create_outcome_unknown"))?;
        if body.len() as u64 > MAX_BODY {
            return Err(failure("jira_create_outcome_unknown"));
        }
        created_id(&body)
    }
    fn created_issue(&mut self, id: &str) -> Result<Issue, Failure> {
        self.read_issue(id)
    }
}

const CREATE_JOURNAL_LIMIT: i64 = 128;

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateLocal {
    due_date: Option<String>,
    estimate_minutes: Option<i64>,
    goal_id: Option<String>,
    important: Option<bool>,
    time: Option<String>,
    task_kind: Option<String>,
    process: Option<String>,
    stage: Option<String>,
    waiting: Option<bool>,
}
impl CreateLocal {
    fn fields(&self) -> crate::calendar_compat::TaskFields {
        crate::calendar_compat::TaskFields {
            time: self.time.clone(),
            task_kind: self.task_kind.clone(),
            sphere: Some("work".into()),
            process: self.process.clone(),
            stage: self.stage.clone(),
            waiting: self.waiting,
        }
    }
    fn validate(&self, conn: &Connection, title: &str) -> Result<(), String> {
        crate::calendar_compat::validate_task_input(
            conn,
            title,
            &self.due_date,
            self.estimate_minutes,
            &self.goal_id,
            &self.fields(),
        )
        .map_err(|_| "jira_create_local_invalid".into())
    }
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateResult {
    request_id: String,
    item_id: String,
    title: String,
    status: String,
    changed: usize,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateRecovery {
    request_id: String,
    state: &'static str,
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    item_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateOptions {
    project: String,
    issue_types: Vec<CreateIssueType>,
    request_id: Option<String>,
    recovery: Option<CreateRecovery>,
}
fn create_scope(config: &Config) -> String {
    hex::encode(Sha256::digest(
        format!("{}\n{}", config.site, config.project).as_bytes(),
    ))
}
fn create_binding(config: &Config) -> String {
    hex::encode(Sha256::digest(
        format!("{}\n{}", create_scope(config), config.token_mode.as_str()).as_bytes(),
    ))
}
fn create_fingerprint(
    title: &str,
    issue_type: &str,
    local: &CreateLocal,
) -> Result<String, String> {
    Ok(hex::encode(Sha256::digest(
        serde_json::to_vec(&json!([title.trim(), issue_type, local])).map_err(storage)?,
    )))
}
fn create_recovery(conn: &Connection, config: &Config) -> Result<Option<CreateRecovery>, String> {
    conn.query_row("SELECT request_id,state,title,item_id,status FROM jira_create_requests WHERE scope_hash=?1 AND state IN ('pending','done')",
        [create_scope(config)], |row| {
            let state: String = row.get(1)?;
            Ok(CreateRecovery { request_id:row.get(0)?, state:if state == "done" { "created" } else { "unknown" },
                title:row.get(2)?, item_id:row.get(3)?, status:row.get(4)? })
        }).optional().map_err(storage)
}
fn prepare_create(conn: &Connection, config: &Config) -> Result<String, String> {
    // Only native-issued, still-retained tickets may dispatch POST. Pruning a
    // completed or unused ticket therefore cannot turn an old replay into a write.
    let tx = conn.unchecked_transaction().map_err(storage)?;
    if create_recovery(&tx, config)?.is_some() {
        return Err("jira_create_recovery_required".into());
    }
    tx.execute(
        "DELETE FROM jira_create_requests WHERE request_id IN (
        SELECT request_id FROM jira_create_requests WHERE state NOT IN ('pending','done')
        ORDER BY rowid LIMIT MAX(0,(SELECT COUNT(*) FROM jira_create_requests)-?1+1))",
        [CREATE_JOURNAL_LIMIT],
    )
    .map_err(storage)?;
    let count: i64 = tx
        .query_row("SELECT COUNT(*) FROM jira_create_requests", [], |r| {
            r.get(0)
        })
        .map_err(storage)?;
    if count >= CREATE_JOURNAL_LIMIT {
        return Err("jira_create_recovery_required".into());
    }
    let request_id = uuid::Uuid::new_v4().to_string();
    tx.execute("INSERT INTO jira_create_requests(request_id,scope_hash,binding_hash,state,created_at) VALUES(?1,?2,?3,'prepared',?4)",
        params![request_id,create_scope(config),create_binding(config),stamp(Utc::now())]).map_err(storage)?;
    tx.commit().map_err(storage)?;
    Ok(request_id)
}
fn acknowledge_create(conn: &Connection, config: &Config, request_id: &str) -> Result<(), String> {
    let changed = conn.execute("UPDATE jira_create_requests SET state='acknowledged' WHERE request_id=?1 AND scope_hash=?2 AND state IN ('pending','done','acknowledged')",
        params![request_id,create_scope(config)]).map_err(storage)?;
    if changed == 1 {
        Ok(())
    } else {
        Err("jira_create_request_invalid".into())
    }
}
fn create_replay(
    conn: &Connection,
    config: &Config,
    request_id: &str,
    fingerprint: &str,
) -> Result<Option<CreateResult>, String> {
    let ticket: Option<(String,String,Option<String>,Option<String>,Option<String>,Option<String>)> = conn.query_row(
        "SELECT binding_hash,state,fingerprint,item_id,title,status FROM jira_create_requests WHERE request_id=?1",
        [request_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).optional().map_err(storage)?;
    let (binding, state, stored, item, title, status) =
        ticket.ok_or("jira_create_request_invalid")?;
    if binding != create_binding(config) {
        return Err("jira_create_configuration_changed".into());
    }
    if stored.as_deref().is_some_and(|value| value != fingerprint) {
        return Err("jira_create_request_conflict".into());
    }
    match state.as_str() {
        "prepared" => Ok(None),
        "pending" => Err("jira_create_outcome_unknown".into()),
        "done" | "acknowledged" if item.is_some() => Ok(Some(CreateResult {
            request_id: request_id.into(),
            item_id: item.unwrap(),
            title: title.unwrap_or_default(),
            status: status.unwrap_or_default(),
            changed: 0,
        })),
        _ => Err("jira_create_request_invalid".into()),
    }
}

fn perform_create(
    db: &Mutex<Connection>,
    config: &Config,
    request_id: &str,
    title: &str,
    issue_type: &str,
    local: &CreateLocal,
    api: &mut impl CreateApi,
) -> Result<CreateResult, String> {
    if !valid_edit_title(title) {
        return Err("jira_title_invalid".into());
    }
    if !valid_remote_id(issue_type) {
        return Err("jira_issue_type_invalid".into());
    }
    let title = title.trim();
    let fingerprint = create_fingerprint(title, issue_type, local)?;
    {
        let conn = lock(db)?;
        if let Some(result) = create_replay(&conn, config, request_id, &fingerprint)? {
            return Ok(result);
        }
        if create_recovery(&conn, config)?.is_some() {
            return Err("jira_create_recovery_required".into());
        }
        local.validate(&conn, title)?;
    }
    if !api
        .issue_types()
        .map_err(|e| e.code)?
        .iter()
        .any(|kind| kind.id == issue_type)
    {
        return Err("jira_issue_type_invalid".into());
    }
    api.check_fields(issue_type).map_err(|e| e.code)?;
    {
        let mut conn = lock(db)?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        if read_config(&tx)? != *config {
            return Err("jira_create_configuration_changed".into());
        }
        if let Some(result) = create_replay(&tx, config, request_id, &fingerprint)? {
            return Ok(result);
        }
        if create_recovery(&tx, config)?.is_some() {
            return Err("jira_create_recovery_required".into());
        }
        local.validate(&tx, title)?;
        tx.execute("UPDATE jira_create_requests SET state='pending',fingerprint=?2,title=?3 WHERE request_id=?1 AND state='prepared'",
            params![request_id,fingerprint,title]).map_err(storage)?;
        // Commit before dispatch. A crash anywhere from here to the final
        // transaction requires explicit recovery, never another automatic POST.
        tx.commit().map_err(storage)?;
    }
    let remote_id = match api.create(issue_type, title) {
        Ok(id) => id,
        Err(error) if error.code == "jira_create_outcome_unknown" => return Err(error.code),
        Err(error) => {
            // A definitive Jira rejection is safe to correct and submit again.
            lock(db)?.execute("UPDATE jira_create_requests SET state='prepared',fingerprint=NULL,title=NULL WHERE request_id=?1 AND state='pending'",
                [request_id]).map_err(|_| "jira_create_outcome_unknown")?;
            return Err(error.code);
        }
    };
    let current = api
        .created_issue(&remote_id)
        .map_err(|_| "jira_create_outcome_unknown")?;
    if current.id != remote_id || current.project.as_deref() != Some(config.project.as_str()) {
        return Err("jira_create_outcome_unknown".into());
    }
    let store = || -> Result<CreateResult, String> {
        let mut conn = lock(db)?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        if read_config(&tx)? != *config {
            return Err("jira_create_configuration_changed".into());
        }
        let item = item_id(&config.site, &current.id);
        let changed = apply(
            &tx,
            &config.site,
            std::slice::from_ref(&current),
            &stamp(Utc::now()),
        )?;
        crate::calendar_compat::save_task_in_transaction(
            &tx,
            Some(item.clone()),
            current.title.clone(),
            local.due_date.clone(),
            local.estimate_minutes,
            local.goal_id.clone(),
            None,
            local.important,
            local.fields(),
        )?;
        tx.execute("UPDATE jira_create_requests SET state='done',item_id=?2,title=?3,status=?4 WHERE request_id=?1 AND state='pending'",
            params![request_id,item,current.title,current.status]).map_err(storage)?;
        tx.commit().map_err(storage)?;
        Ok(CreateResult {
            request_id: request_id.into(),
            item_id: item,
            title: current.title.clone(),
            status: current.status.clone(),
            changed,
        })
    };
    store().map_err(|_| "jira_create_outcome_unknown".into())
}

#[tauri::command]
pub async fn jira_create_options(app: tauri::AppHandle) -> Result<Value, String> {
    blocking(app, |app| {
        let runtime = app.state::<Runtime>();
        let _running = runtime
            .import
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let db = &app.state::<crate::AppState>().0;
        let config = read_config(&*lock(db)?)?;
        if !config.ready() {
            return Err("jira_not_configured".into());
        }
        let recovery = create_recovery(&*lock(db)?, &config)?;
        let (issue_types, request_id) = if recovery.is_some() {
            (Vec::new(), None)
        } else {
            let credential = runtime.credential()?.ok_or("jira_token_required")?;
            if credential.site != config.site {
                return Err("jira_token_required_for_site".into());
            }
            if credential.token_mode != config.token_mode {
                return Err("jira_token_required_for_mode".into());
            }
            let mut api = HttpTaskApi::new(&config, &credential).map_err(|e| e.code)?;
            let types = api.issue_types().map_err(|e| e.code)?;
            let conn = lock(db)?;
            if read_config(&conn)? != config {
                return Err("jira_create_configuration_changed".into());
            }
            (types, Some(prepare_create(&conn, &config)?))
        };
        serde_json::to_value(CreateOptions {
            project: config.project,
            issue_types,
            request_id,
            recovery,
        })
        .map_err(storage)
    })
    .await
}
#[tauri::command(rename_all = "camelCase")]
pub async fn jira_task_create(
    app: tauri::AppHandle,
    request_id: String,
    title: String,
    issue_type_id: String,
    local: CreateLocal,
) -> Result<Value, String> {
    blocking(app, move |app| {
        let runtime = app.state::<Runtime>();
        let _running = runtime
            .import
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let db = &app.state::<crate::AppState>().0;
        let config = read_config(&*lock(db)?)?;
        if !config.ready() {
            return Err("jira_not_configured".into());
        }
        if let Some(result) = create_replay(
            &*lock(db)?,
            &config,
            &request_id,
            &create_fingerprint(&title, &issue_type_id, &local)?,
        )? {
            return serde_json::to_value(result).map_err(storage);
        }
        let credential = runtime.credential()?.ok_or("jira_token_required")?;
        if credential.site != config.site {
            return Err("jira_token_required_for_site".into());
        }
        if credential.token_mode != config.token_mode {
            return Err("jira_token_required_for_mode".into());
        }
        let mut api = HttpTaskApi::new(&config, &credential).map_err(|e| e.code)?;
        serde_json::to_value(perform_create(
            db,
            &config,
            &request_id,
            &title,
            &issue_type_id,
            &local,
            &mut api,
        )?)
        .map_err(storage)
    })
    .await
}
#[tauri::command(rename_all = "camelCase")]
pub async fn jira_create_acknowledge(
    app: tauri::AppHandle,
    request_id: String,
) -> Result<Value, String> {
    blocking(app, move |app| {
        let runtime = app.state::<Runtime>();
        let _running = runtime
            .import
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let state = app.state::<crate::AppState>();
        let conn = lock(&state.0)?;
        let config = read_config(&conn)?;
        acknowledge_create(&conn, &config, &request_id)?;
        Ok(json!({"acknowledged":true}))
    })
    .await
}

// ---- Commands ----

fn current_status(app: &tauri::AppHandle, changed: usize) -> Result<Value, String> {
    status(
        &app.state::<Runtime>(),
        &app.state::<crate::AppState>().0,
        changed,
    )
}

async fn blocking(
    app: tauri::AppHandle,
    work: impl FnOnce(&tauri::AppHandle) -> Result<Value, String> + Send + 'static,
) -> Result<Value, String> {
    if !SUPPORTED {
        return Err("jira_unsupported".into());
    }
    tauri::async_runtime::spawn_blocking(move || work(&app))
        .await
        .map_err(|_| "jira_import_failed".to_string())?
}

fn import(app: &tauri::AppHandle, trigger: Trigger) -> Result<Value, String> {
    let changed = import_once(
        &app.state::<Runtime>(),
        &app.state::<crate::AppState>().0,
        trigger,
        fetch,
    )?;
    current_status(app, changed)
}

#[tauri::command]
pub async fn jira_import_status(app: tauri::AppHandle) -> Result<Value, String> {
    if !SUPPORTED {
        return Ok(json!({"supported":false}));
    }
    blocking(app, |app| current_status(app, 0)).await
}

/// Saves site, project and email; an empty token keeps the stored one for the
/// same site only.
#[tauri::command(rename_all = "camelCase")]
pub async fn jira_import_configure(
    app: tauri::AppHandle,
    site: String,
    project: String,
    email: String,
    token: Option<String>,
    token_mode: Option<TokenMode>,
) -> Result<Value, String> {
    blocking(app, move |app| {
        let runtime = app.state::<Runtime>();
        let running = runtime
            .import
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        configure(
            &app.state::<Runtime>(),
            &app.state::<crate::AppState>().0,
            &site,
            &project,
            &email,
            token,
            token_mode.unwrap_or_default(),
            Utc::now(),
        )?;
        drop(running);
        current_status(app, 0)
    })
    .await
}

#[tauri::command]
pub async fn jira_import_disable(app: tauri::AppHandle) -> Result<Value, String> {
    blocking(app, |app| {
        let runtime = app.state::<Runtime>();
        let running = runtime
            .import
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        disable(
            &app.state::<Runtime>(),
            &app.state::<crate::AppState>().0,
            Utc::now(),
        )?;
        drop(running);
        current_status(app, 0)
    })
    .await
}

#[tauri::command]
pub async fn jira_import_now(app: tauri::AppHandle) -> Result<Value, String> {
    blocking(app, |app| import(app, Trigger::Manual)).await
}

/// The periodic check. Not configured, not due or paused: nothing happens.
#[tauri::command]
pub async fn jira_import_tick(app: tauri::AppHandle) -> Result<Value, String> {
    if !SUPPORTED {
        return Ok(json!({"supported":false}));
    }
    blocking(app, |app| import(app, Trigger::Automatic)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    const SITE: &str = "example.atlassian.net";
    const T0: &str = "2026-09-25T09:00:00Z";

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::init_schema(&conn).unwrap();
        conn
    }
    fn at(value: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(value)
            .unwrap()
            .with_timezone(&Utc)
    }
    fn issue(id: &str, summary: &str) -> Issue {
        Issue {
            id: id.into(),
            project: Some("DEMO".into()),
            title: clean_title(summary).unwrap(),
            status: "В работе".into(),
        }
    }
    fn credential() -> Credential {
        Credential {
            v: CREDENTIAL_VERSION,
            token_mode: TokenMode::Classic,
            site: SITE.into(),
            email: "demo@example.com".into(),
            token: "fictional-token".into(),
        }
    }
    /// The secret store in memory; never the user's Keychain.
    #[derive(Default)]
    struct MemoryVault {
        value: Mutex<Option<String>>,
        unreadable: std::sync::atomic::AtomicBool,
        undeletable: std::sync::atomic::AtomicBool,
        reads: AtomicU64,
    }
    impl Vault for MemoryVault {
        fn read(&self) -> Result<Option<String>, String> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            if self.unreadable.load(Ordering::SeqCst) {
                return Err("mvp_sync_credentials_unavailable".into());
            }
            Ok(self.value.lock().unwrap().clone())
        }
        fn write(&self, raw: &str) -> Result<(), String> {
            *self.value.lock().unwrap() = Some(raw.to_owned());
            Ok(())
        }
        fn delete(&self) -> Result<(), String> {
            if self.undeletable.load(Ordering::SeqCst) {
                return Err("mvp_sync_credentials_write_failed".into());
            }
            *self.value.lock().unwrap() = None;
            Ok(())
        }
    }
    impl MemoryVault {
        fn stored(&self) -> Option<String> {
            self.value.lock().unwrap().clone()
        }
    }
    fn runtime_with(stored: Option<&Credential>) -> (Runtime, Arc<MemoryVault>) {
        let vault = Arc::new(MemoryVault::default());
        *vault.value.lock().unwrap() = stored.map(|value| serde_json::to_string(value).unwrap());
        (Runtime::with_vault(vault.clone()), vault)
    }
    /// A profile connected to the fictional site and project with a saved token.
    fn configured() -> (Mutex<Connection>, Runtime, Arc<MemoryVault>) {
        let db = Mutex::new(db());
        save_config(&lock(&db).unwrap(), SITE, "DEMO", TokenMode::Classic, T0).unwrap();
        let (runtime, vault) = runtime_with(Some(&credential()));
        (db, runtime, vault)
    }
    fn state(db: &Mutex<Connection>) -> Value {
        status_value(&lock(db).unwrap(), None, false, 0).unwrap()
    }
    fn one_issue() -> Result<Fetched, Failure> {
        Ok(Fetched {
            issues: vec![issue("10001", "Fictional")],
            truncated: false,
        })
    }
    fn row(conn: &Connection, id: &str) -> (String, String, i64, String, bool) {
        conn.query_row(
            "SELECT title,tags,version,status,completed FROM items WHERE id=?1",
            [id],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get::<_, i64>(4)? != 0,
                ))
            },
        )
        .unwrap()
    }
    fn count(conn: &Connection) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0))
            .unwrap()
    }
    fn import(conn: &Connection, issues: &[Issue]) -> usize {
        let tx = conn.unchecked_transaction().unwrap();
        let changed = apply(&tx, SITE, issues, T0).unwrap();
        tx.commit().unwrap();
        changed
    }

    struct FakeCreateApi<'a> {
        calls: Vec<&'static str>,
        failure: Option<&'static str>,
        fields_failure: bool,
        read_failure: bool,
        current: Issue,
        before_post: Option<Box<dyn FnOnce() + 'a>>,
        after_post: Option<Box<dyn FnOnce() + 'a>>,
    }
    impl FakeCreateApi<'_> {
        fn new() -> Self {
            Self {
                calls: vec![],
                failure: None,
                fields_failure: false,
                read_failure: false,
                current: issue("987654321987654", "BE: Fictional check"),
                before_post: None,
                after_post: None,
            }
        }
    }
    impl CreateApi for FakeCreateApi<'_> {
        fn issue_types(&mut self) -> Result<Vec<CreateIssueType>, Failure> {
            self.calls.push("types");
            Ok(vec![CreateIssueType {
                id: "100".into(),
                name: "Task".into(),
            }])
        }
        fn check_fields(&mut self, _: &str) -> Result<(), Failure> {
            self.calls.push("fields");
            if let Some(hook) = self.before_post.take() {
                hook();
            }
            if self.fields_failure {
                Err(failure("jira_create_required_fields"))
            } else {
                Ok(())
            }
        }
        fn create(&mut self, _: &str, title: &str) -> Result<String, Failure> {
            self.calls.push("POST");
            self.current.title = title.into();
            if let Some(hook) = self.after_post.take() {
                hook();
            }
            match self.failure {
                Some(code) => Err(failure(code)),
                None => Ok(self.current.id.clone()),
            }
        }
        fn created_issue(&mut self, id: &str) -> Result<Issue, Failure> {
            self.calls.push("read");
            assert_eq!(id, self.current.id);
            if self.read_failure {
                Err(failure("jira_timeout"))
            } else {
                Ok(self.current.clone())
            }
        }
    }
    fn create_fixture() -> (Mutex<Connection>, Config, String) {
        let (db, _, _) = configured();
        let config = read_config(&lock(&db).unwrap()).unwrap();
        let request = prepare_create(&lock(&db).unwrap(), &config).unwrap();
        (db, config, request)
    }
    fn submit(
        db: &Mutex<Connection>,
        config: &Config,
        request: &str,
        api: &mut impl CreateApi,
    ) -> Result<CreateResult, String> {
        perform_create(
            db,
            config,
            request,
            "BE: Fictional check",
            "100",
            &CreateLocal::default(),
            api,
        )
    }

    #[test]
    fn create_success_preserves_local_options_and_replays_without_post() {
        let (db, config, request) = create_fixture();
        let mut api = FakeCreateApi::new();
        {
            let conn = lock(&db).unwrap();
            conn.execute("INSERT INTO calendar_goals(id,title,created_at,updated_at) VALUES('fictional-goal','Goal',?1,?1)",[T0]).unwrap();
            import(&conn, &[issue("54321", "Other active task")]);
            conn.execute("INSERT INTO timeline_blocks(source_type,source_id,date,start_time,is_active,created_at,updated_at) VALUES('note',?1,'2026-09-25','09:00',1,?2,?2)",
                params![item_id(SITE,"54321"),T0]).unwrap();
        }
        let local = CreateLocal {
            due_date: Some("2026-10-01".into()),
            estimate_minutes: Some(30),
            important: Some(true),
            time: Some("10:30".into()),
            task_kind: Some("normal".into()),
            process: Some("custom".into()),
            stage: Some("review".into()),
            waiting: Some(true),
            goal_id: Some("fictional-goal".into()),
            ..CreateLocal::default()
        };
        let result = perform_create(
            &db,
            &config,
            &request,
            "BE: Fictional check",
            "100",
            &local,
            &mut api,
        )
        .unwrap();
        assert_eq!(api.calls, vec!["types", "fields", "POST", "read"]);
        assert_eq!(result.item_id, item_id(SITE, "987654321987654"));
        let conn = lock(&db).unwrap();
        let stored = row(&conn, &result.item_id);
        assert_eq!(attributes::sphere(&stored.1), Some("work"));
        assert_eq!(attributes::process(&stored.1), Some("custom"));
        assert_eq!(attributes::stage(&stored.1), Some("review"));
        assert!(attributes::waiting(&stored.1));
        assert!(!stored.4);
        let planning: (String, String, i64, i64, String) = conn
            .query_row(
                "SELECT date,time,duration_minutes,priority,notes FROM items WHERE id=?1",
                [&result.item_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .unwrap();
        assert_eq!(
            planning,
            ("2026-10-01".into(), "10:30".into(), 30, 5, "".into())
        );
        assert_eq!(
            conn.query_row(
                "SELECT goal_id FROM calendar_task_goals WHERE source_id=?1",
                [&result.item_id],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "fictional-goal"
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM timeline_blocks WHERE is_active=1 AND source_id=?1",
                [item_id(SITE, "54321")],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM timeline_blocks WHERE source_id=?1",
                [&result.item_id],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        let recovery = create_recovery(&conn, &config).unwrap().unwrap();
        assert_eq!(recovery.state, "created");
        assert_eq!(recovery.item_id.as_deref(), Some(result.item_id.as_str()));
        assert_eq!(
            prepare_create(&conn, &config).unwrap_err(),
            "jira_create_recovery_required"
        );
        let sync: String = conn
            .query_row("SELECT group_concat(data) FROM mvp_records", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert!(!sync.contains(&request));
        assert!(!sync.contains("987654321987654"));
        assert!(!sync.contains("jira_create_requests"));
        drop(conn);
        let again = perform_create(
            &db,
            &config,
            &request,
            "BE: Fictional check",
            "100",
            &local,
            &mut api,
        )
        .unwrap();
        assert_eq!(again.item_id, result.item_id);
        assert_eq!(again.changed, 0);
        assert_eq!(api.calls.len(), 4);
        assert_eq!(
            submit(&db, &config, &request, &mut api).unwrap_err(),
            "jira_create_request_conflict"
        );
        acknowledge_create(&lock(&db).unwrap(), &config, &request).unwrap();
        assert!(create_recovery(&lock(&db).unwrap(), &config)
            .unwrap()
            .is_none());
        assert_eq!(
            perform_create(
                &db,
                &config,
                &request,
                "BE: Fictional check",
                "100",
                &local,
                &mut api
            )
            .unwrap()
            .item_id,
            result.item_id
        );
        assert_eq!(api.calls.len(), 4);
    }

    #[test]
    fn create_unknown_survives_reopen_blocks_new_tickets_and_never_replays() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("synthetic.db");
        let conn = Connection::open(&path).unwrap();
        crate::init_schema(&conn).unwrap();
        save_config(&conn, SITE, "DEMO", TokenMode::Classic, T0).unwrap();
        let config = read_config(&conn).unwrap();
        let request = prepare_create(&conn, &config).unwrap();
        let db = Mutex::new(conn);
        let mut api = FakeCreateApi::new();
        api.failure = Some("jira_create_outcome_unknown");
        assert_eq!(
            submit(&db, &config, &request, &mut api).unwrap_err(),
            "jira_create_outcome_unknown"
        );
        drop(db);
        let conn = Connection::open(&path).unwrap();
        crate::init_schema(&conn).unwrap();
        let pending = create_recovery(&conn, &config).unwrap().unwrap();
        assert_eq!(pending.state, "unknown");
        assert_eq!(pending.title, "BE: Fictional check");
        assert_eq!(pending.item_id, None);
        assert_eq!(
            prepare_create(&conn, &config).unwrap_err(),
            "jira_create_recovery_required"
        );
        let db = Mutex::new(conn);
        let mut retry = FakeCreateApi::new();
        assert_eq!(
            submit(&db, &config, &request, &mut retry).unwrap_err(),
            "jira_create_outcome_unknown"
        );
        assert!(retry.calls.is_empty());
        let conn = lock(&db).unwrap();
        let mode = Config {
            token_mode: TokenMode::Scoped,
            ..config.clone()
        };
        assert_eq!(
            create_recovery(&conn, &mode).unwrap().unwrap().request_id,
            request
        );
        let other = Config {
            project: "OTHER".into(),
            ..config.clone()
        };
        assert!(create_recovery(&conn, &other).unwrap().is_none());
        assert_eq!(
            acknowledge_create(&conn, &other, &request).unwrap_err(),
            "jira_create_request_invalid"
        );
        assert!(create_recovery(&conn, &config).unwrap().is_some());
        acknowledge_create(&conn, &config, &request).unwrap();
        let new_request = prepare_create(&conn, &config).unwrap();
        assert_ne!(new_request, request);
        drop(conn);
        assert_eq!(
            submit(&db, &config, &request, &mut retry).unwrap_err(),
            "jira_create_request_invalid"
        );
        assert!(retry.calls.is_empty());
    }

    #[test]
    fn create_validates_request_fields_and_binding_before_post() {
        let (db, config, request) = create_fixture();
        let mut api = FakeCreateApi::new();
        assert_eq!(
            submit(&db, &config, "forged-request", &mut api).unwrap_err(),
            "jira_create_request_invalid"
        );
        let other = Config {
            project: "OTHER".into(),
            ..config.clone()
        };
        assert_eq!(
            submit(&db, &other, &request, &mut api).unwrap_err(),
            "jira_create_configuration_changed"
        );
        for local in [
            CreateLocal {
                due_date: Some("invalid".into()),
                ..CreateLocal::default()
            },
            CreateLocal {
                time: Some("10:00".into()),
                ..CreateLocal::default()
            },
            CreateLocal {
                goal_id: Some("missing".into()),
                ..CreateLocal::default()
            },
            CreateLocal {
                estimate_minutes: Some(0),
                ..CreateLocal::default()
            },
            CreateLocal {
                process: Some("bad,id".into()),
                ..CreateLocal::default()
            },
        ] {
            assert_eq!(
                perform_create(&db, &config, &request, "Title", "100", &local, &mut api)
                    .unwrap_err(),
                "jira_create_local_invalid"
            );
        }
        assert!(api.calls.is_empty());
        assert!(serde_json::from_value::<CreateLocal>(json!({"description":"forbidden"})).is_err());
        assert_eq!(
            perform_create(
                &db,
                &config,
                &request,
                "Title",
                "999",
                &CreateLocal::default(),
                &mut api
            )
            .unwrap_err(),
            "jira_issue_type_invalid"
        );
        api.fields_failure = true;
        assert_eq!(
            submit(&db, &config, &request, &mut api).unwrap_err(),
            "jira_create_required_fields"
        );
        assert!(!api.calls.contains(&"POST"));
        api.fields_failure = false;
        api.before_post = Some(Box::new(|| {
            save_config(&lock(&db).unwrap(), SITE, "OTHER", TokenMode::Classic, T0).unwrap()
        }));
        assert_eq!(
            submit(&db, &config, &request, &mut api).unwrap_err(),
            "jira_create_configuration_changed"
        );
        assert!(!api.calls.contains(&"POST"));
    }

    #[test]
    fn create_readback_or_local_failure_retains_unknown_and_rolls_back() {
        for fault in 0..3 {
            let (db, config, request) = create_fixture();
            let mut api = FakeCreateApi::new();
            match fault {
                0 => api.read_failure = true,
                1 => api.current.project = Some("OTHER".into()),
                _ => lock(&db).unwrap().execute_batch("CREATE TRIGGER fail_create_journal BEFORE UPDATE ON jira_create_requests WHEN NEW.state='done' BEGIN SELECT RAISE(FAIL,'synthetic'); END").unwrap(),
            }
            assert_eq!(
                submit(&db, &config, &request, &mut api).unwrap_err(),
                "jira_create_outcome_unknown"
            );
            let conn = lock(&db).unwrap();
            assert_eq!(count(&conn), 0);
            assert_eq!(
                conn.query_row("SELECT COUNT(*) FROM jira_import_links", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
            assert_eq!(
                create_recovery(&conn, &config).unwrap().unwrap().state,
                "unknown"
            );
            drop(conn);
            assert_eq!(
                submit(&db, &config, &request, &mut api).unwrap_err(),
                "jira_create_outcome_unknown"
            );
            assert_eq!(api.calls.iter().filter(|op| **op == "POST").count(), 1);
        }
    }

    #[test]
    fn create_rejection_can_be_corrected_but_concurrent_submission_is_blocked() {
        let (db, config, request) = create_fixture();
        let second = prepare_create(&lock(&db).unwrap(), &config).unwrap();
        let mut api = FakeCreateApi::new();
        api.failure = Some("jira_forbidden");
        assert_eq!(
            submit(&db, &config, &request, &mut api).unwrap_err(),
            "jira_forbidden"
        );
        assert!(create_recovery(&lock(&db).unwrap(), &config)
            .unwrap()
            .is_none());
        api.failure = None;
        api.after_post = Some(Box::new(|| {
            let mut concurrent = FakeCreateApi::new();
            assert_eq!(
                submit(&db, &config, &second, &mut concurrent).unwrap_err(),
                "jira_create_recovery_required"
            );
            assert_eq!(
                submit(&db, &config, &request, &mut concurrent).unwrap_err(),
                "jira_create_outcome_unknown"
            );
            assert!(concurrent.calls.is_empty());
        }));
        let result = submit(&db, &config, &request, &mut api).unwrap();
        let tags = row(&lock(&db).unwrap(), &result.item_id).1;
        assert_eq!(attributes::process(&tags), None);
        assert_eq!(attributes::stage(&tags), None);
        assert_eq!(api.calls.iter().filter(|op| **op == "POST").count(), 2);
    }

    #[test]
    fn create_journal_is_bounded_and_eviction_cannot_authorize_an_old_ticket() {
        let (db, config, request) = create_fixture();
        for _ in 0..CREATE_JOURNAL_LIMIT + 2 {
            prepare_create(&lock(&db).unwrap(), &config).unwrap();
        }
        assert_eq!(
            lock(&db)
                .unwrap()
                .query_row("SELECT COUNT(*) FROM jira_create_requests", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            CREATE_JOURNAL_LIMIT
        );
        let mut api = FakeCreateApi::new();
        assert_eq!(
            submit(&db, &config, &request, &mut api).unwrap_err(),
            "jira_create_request_invalid"
        );
        assert!(api.calls.is_empty());
    }

    #[test]
    fn site_project_email_and_token_input_are_validated() {
        assert_eq!(
            normalize_site(" https://Example.Atlassian.net/ ").unwrap(),
            SITE
        );
        assert_eq!(normalize_site(SITE).unwrap(), SITE);
        for raw in [
            "",
            "http://example.atlassian.net",
            "https://example.atlassian.net/jira",
            "https://user@example.atlassian.net",
            "example.atlassian.net:443",
            "https://example.atlassian.net?x=1",
            "example.atlassian.net#a",
            "https://example.atlassian.net//",
            "ftp://example.atlassian.net",
            "127.0.0.1",
            "exa mple.atlassian.net",
            "https://",
        ] {
            assert_eq!(
                normalize_site(raw).unwrap_err(),
                "jira_site_invalid",
                "{raw}"
            );
        }
        assert_eq!(normalize_project(" demo ").unwrap(), "DEMO");
        for raw in [
            "",
            "1DEMO",
            "DE-MO",
            "DEMO\"",
            "DEMO OR 1=1",
            &"A".repeat(21),
        ] {
            assert_eq!(
                normalize_project(raw).unwrap_err(),
                "jira_project_invalid",
                "{raw}"
            );
        }
        assert!(valid_email("demo@example.com"));
        for raw in [
            "",
            "demo",
            "@example.com",
            "demo@",
            "de mo@example.com",
            "demo:x@example.com",
        ] {
            assert!(!valid_email(raw), "{raw}");
        }
        assert!(valid_token("fictional-TOKEN_123="));
        assert!(!valid_token("") && !valid_token("with space") && !valid_token(&"a".repeat(1025)));
        assert!(jql("DEMO").starts_with("project = \"DEMO\""));
    }

    #[test]
    fn create_metadata_is_paginated_projected_and_fail_closed() {
        let mut starts = Vec::new();
        let types = collect_create_types(|start| {
            starts.push(start);
            Ok(if start == 0 {
                json!({"startAt":0,"total":2,"issueTypes":[{"id":"100","name":"Task","subtask":false,
                    "description":"FORBIDDEN_DESCRIPTION","self":"https://forbidden.invalid/","avatarUrl":"FORBIDDEN"}]})
            } else {
                json!({"startAt":1,"total":2,"issueTypes":[{"id":"101","name":"Subtask","subtask":true}]})
            }.to_string().into_bytes())
        }).unwrap();
        assert_eq!(starts, vec![0, 1]);
        assert_eq!(
            serde_json::to_value(types).unwrap(),
            json!([{"id":"100","name":"Task"}])
        );
        for page in [
            json!({"startAt":1,"total":1,"issueTypes":[]}),
            json!({"startAt":0,"total":1,"issueTypes":[]}),
            json!({"startAt":0,"total":3000,"issueTypes":[]}),
            json!({"startAt":0,"total":1,"issueTypes":[{"id":"100","name":"Task"}]}),
            json!({"startAt":0,"total":1,"issueTypes":[{"id":"../100","name":"Task","subtask":false}]}),
        ] {
            assert_eq!(
                collect_create_types(|_| Ok(page.to_string().into_bytes()))
                    .unwrap_err()
                    .code,
                "jira_response_invalid"
            );
        }
        let supported = json!([
            {"fieldId":"summary","required":true,"operations":["set"]},
            {"fieldId":"project","required":true,"operations":[]},
            {"fieldId":"issuetype","required":true,"operations":[]},
            {"fieldId":"assignee","required":true,"hasDefaultValue":true,"operations":["set"],
                "allowedValues":[{"accountId":"FORBIDDEN_PERSON"}],"defaultValue":{"displayName":"FORBIDDEN_PERSON"}}
        ]);
        let fields = supported.as_array().unwrap();
        assert!(check_create_fields(|start| Ok(
            json!({"startAt":start,"total":4,"fields":&fields[start..start+1]})
                .to_string()
                .into_bytes()
        ))
        .is_ok());
        let mut required = fields.clone();
        required[3]["hasDefaultValue"] = json!(false);
        assert_eq!(
            check_create_fields(|_| Ok(json!({"startAt":0,"total":4,"fields":required})
                .to_string()
                .into_bytes()))
            .unwrap_err()
            .code,
            "jira_create_required_fields"
        );
        assert_eq!(
            check_create_fields(|_| Ok(json!({"startAt":0,"total":0,"fields":[]})
                .to_string()
                .into_bytes()))
            .unwrap_err()
            .code,
            "jira_create_required_fields"
        );
    }

    #[test]
    fn create_requests_only_send_three_fields_to_the_bound_project() {
        let (_, _, _) = configured();
        let config = Config {
            site: SITE.into(),
            project: "DEMO".into(),
            enabled: true,
            token_mode: TokenMode::Classic,
        };
        let client = client().unwrap();
        let credential = credential();
        let request = create_request(
            client,
            &config,
            &credential,
            None,
            CreateRequest::Create {
                issue_type: "100",
                title: "BE: Fictional check",
            },
        )
        .unwrap();
        assert_eq!(
            request.url().as_str(),
            "https://example.atlassian.net/rest/api/3/issue"
        );
        assert_eq!(request.method(), reqwest::Method::POST);
        assert_eq!(
            serde_json::from_slice::<Value>(request.body().unwrap().as_bytes().unwrap()).unwrap(),
            json!({"fields":{"summary":"BE: Fictional check","project":{"key":"DEMO"},"issuetype":{"id":"100"}}})
        );
        let fields = create_request(
            client,
            &config,
            &credential,
            None,
            CreateRequest::Fields {
                issue_type: "100",
                start: 100,
            },
        )
        .unwrap();
        assert_eq!(fields.url().as_str(), "https://example.atlassian.net/rest/api/3/issue/createmeta/DEMO/issuetypes/100?startAt=100&maxResults=100");
        assert!(create_request(
            client,
            &config,
            &credential,
            None,
            CreateRequest::Fields {
                issue_type: "../100",
                start: 0
            }
        )
        .is_err());
        let wrong = Config {
            site: "other.atlassian.net".into(),
            ..config
        };
        assert!(
            create_request(client, &wrong, &credential, None, CreateRequest::Types(0)).is_err()
        );
        assert!(create_status(201, None).is_ok());
        for status in [200, 204, 408, 500, 502, 503] {
            assert_eq!(
                create_status(status, None).unwrap_err().code,
                "jira_create_outcome_unknown"
            );
        }
        assert_eq!(create_status(403, None).unwrap_err().code, "jira_forbidden");
        assert_eq!(
            created_id(br#"{"id":"10001","key":"FORBIDDEN-1","self":"FORBIDDEN_URL"}"#).unwrap(),
            "10001"
        );
        assert!(created_id(br#"{"key":"DEMO-1"}"#).is_err());
    }

    #[test]
    fn a_stored_credential_is_strict_and_never_serialized_into_status() {
        let raw = serde_json::to_string(&credential()).unwrap();
        assert!(Credential::parse(&raw).is_ok());
        for raw in [
            "",
            "{}",
            "not json",
            r#"{"v":1,"email":"demo@example.com","token":"t"}"#,
            r#"{"v":2,"email":"demo@example.com","token":"t"}"#,
            r#"{"v":3,"token_mode":"classic","site":"example.com","email":"demo@example.com","token":"t"}"#,
            r#"{"v":3,"token_mode":"classic","site":"example.atlassian.net","email":"demo@example.com","token":"t","extra":1}"#,
        ] {
            assert_eq!(
                Credential::parse(raw).err().as_deref(),
                Some("jira_token_unavailable"),
                "{raw}"
            );
        }
        assert_eq!(
            store_error("mvp_sync_credentials_unavailable".into()),
            "jira_token_unavailable"
        );
        assert_eq!(
            store_error("mvp_sync_credentials_invalid".into()),
            "jira_token_unavailable"
        );
        assert_eq!(
            store_error("mvp_sync_credentials_write_failed".into()),
            "jira_token_write_failed"
        );
        assert_eq!(
            store_error("mvp_sync_credentials_verify_failed".into()),
            "jira_token_write_failed"
        );
        let conn = db();
        save_config(&conn, SITE, "DEMO", TokenMode::Classic, T0).unwrap();
        let status = status_value(&conn, Some(&Ok(Some(credential()))), false, 0).unwrap();
        assert_eq!(
            (
                status["email"].as_str(),
                status["tokenSaved"].as_bool(),
                status["site"].as_str()
            ),
            (Some("demo@example.com"), Some(true), Some(SITE))
        );
        assert!(!status.to_string().contains("fictional-token"));
        let blocked =
            status_value(&conn, Some(&Err("jira_token_unavailable".into())), false, 0).unwrap();
        assert_eq!(blocked["lastError"], "jira_token_unavailable");
        assert_eq!(blocked["tokenSaved"], false);
    }

    #[test]
    fn a_new_issue_becomes_a_work_task_without_process_or_source_metadata() {
        let conn = db();
        assert_eq!(
            import(&conn, &[issue("10001", "  Fictional\nrequirement  ")]),
            1
        );
        let id = item_id(SITE, "10001");
        assert!(id.starts_with("jira:") && !id.contains("10001"));
        let (title, tags, version, status, completed) = row(&conn, &id);
        assert_eq!(
            (title.as_str(), version, status.as_str(), completed),
            ("Fictional requirement", 1, "task", false)
        );
        assert_eq!(
            tags,
            attributes::with_jira_status("task-sphere:work", "В работе")
        );
        assert!(attributes::process(&tags).is_none());
        assert!(attributes::stage_log(&tags).is_empty() && attributes::stage(&tags).is_none());
        let (kind, category, duration, date): (String, String, i64, Option<String>) = conn
            .query_row(
                "SELECT kind,category,duration_minutes,date FROM items WHERE id=?1",
                [&id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(
            (kind.as_str(), category.as_str(), duration, date),
            ("task", "task", 0, None)
        );
        crate::health_sleep::editable(&id).unwrap();
    }

    #[test]
    fn a_repeated_import_changes_nothing() {
        let conn = db();
        let issues = [issue("10001", "First"), issue("10002", "Second")];
        assert_eq!(import(&conn, &issues), 2);
        let dirty = || {
            conn.query_row("SELECT MAX(seq) FROM content_sync_dirty", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap()
        };
        let before = dirty();
        assert_eq!(import(&conn, &issues), 0);
        assert_eq!(count(&conn), 2);
        assert_eq!(
            row(&conn, &item_id(SITE, "10001")).2,
            1,
            "no version bump without a change"
        );
        assert_eq!(dirty(), before, "no new sync record");
    }

    #[test]
    fn the_title_follows_jira_until_the_user_renames_the_task() {
        let conn = db();
        let id = item_id(SITE, "10001");
        import(&conn, &[issue("10001", "Draft")]);
        assert_eq!(import(&conn, &[issue("10001", "Reworded in Jira")]), 1);
        assert_eq!(
            (row(&conn, &id).0.as_str(), row(&conn, &id).2),
            ("Reworded in Jira", 2)
        );
        conn.execute(
            "UPDATE items SET title='My own words',version=version+1 WHERE id=?1",
            [&id],
        )
        .unwrap();
        assert_eq!(import(&conn, &[issue("10001", "Changed again")]), 0);
        assert_eq!(row(&conn, &id).0, "My own words");
        assert_eq!(import(&conn, &[issue("10001", "And again")]), 0);
        assert_eq!(row(&conn, &id).0, "My own words");
    }

    #[test]
    fn an_import_preserves_user_process_stage_sphere_and_planning() {
        let conn = db();
        let id = item_id(SITE, "10001");
        import(&conn, &[issue("10001", "Moved")]);
        // The user picks a stage, a personal sphere and «Жду ответа» in Cicada.
        let tags = row(&conn, &id).1;
        let edited = attributes::write(
            &attributes::edit_stage(
                &tags,
                attributes::StageEdit {
                    process: Some("system-analysis"),
                    stage: Some("analysis"),
                    waiting: Some(true),
                },
                T0,
                T0,
            ),
            None,
            Some("home"),
        );
        conn.execute(
            "UPDATE items SET tags=?1,date='2026-09-26',priority=5 WHERE id=?2",
            params![edited, id],
        )
        .unwrap();
        conn.execute("INSERT INTO timeline_blocks(source_type,source_id,date,start_time,duration_seconds,is_active,created_at,updated_at) VALUES('note',?1,'2026-09-25','09:00',73,1,?2,?2)", params![id, T0]).unwrap();
        assert_eq!(import(&conn, &[issue("10001", "Updated title")]), 1);
        let timer: (i64, bool) = conn
            .query_row(
                "SELECT duration_seconds,is_active FROM timeline_blocks WHERE source_id=?1",
                [&id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(timer, (73, true));
        let tags = row(&conn, &id).1;
        assert_eq!(
            (
                attributes::stage(&tags),
                attributes::waiting(&tags),
                attributes::sphere(&tags),
                attributes::process(&tags)
            ),
            (
                Some("analysis"),
                true,
                Some("home"),
                Some("system-analysis")
            )
        );
        assert_eq!(attributes::stage_log(&tags).len(), 1);
        assert_eq!(
            count(&conn),
            1,
            "the issue id, not the key, identifies the task"
        );
        let (date, priority): (String, i64) = conn
            .query_row("SELECT date,priority FROM items WHERE id=?1", [&id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!((date.as_str(), priority), ("2026-09-26", 5));
    }

    #[test]
    fn a_task_reopened_in_cicada_follows_jira_renames_again() {
        let conn = db();
        let id = item_id(SITE, "10001");
        import(&conn, &[issue("10001", "Draft")]);
        conn.execute(
            "UPDATE items SET completed=1,status='done' WHERE id=?1",
            [&id],
        )
        .unwrap();
        assert_eq!(import(&conn, &[issue("10001", "Renamed while closed")]), 0);
        let last: String = conn
            .query_row(
                "SELECT last_summary FROM jira_import_links WHERE item_id=?1",
                [&id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            last, "Draft",
            "a closed task keeps the summary it was imported with"
        );
        conn.execute(
            "UPDATE items SET completed=0,status='task' WHERE id=?1",
            [&id],
        )
        .unwrap();
        assert_eq!(import(&conn, &[issue("10001", "Renamed while closed")]), 1);
        assert_eq!(row(&conn, &id).0, "Renamed while closed");
    }

    #[test]
    fn a_completed_task_is_never_reopened_or_changed() {
        let conn = db();
        let id = item_id(SITE, "10001");
        import(&conn, &[issue("10001", "Done in Cicada")]);
        conn.execute(
            "UPDATE items SET completed=1,status='done',version=version+1 WHERE id=?1",
            [&id],
        )
        .unwrap();
        assert_eq!(import(&conn, &[issue("10001", "Still open in Jira")]), 0);
        let (title, tags, version, status, completed) = row(&conn, &id);
        assert_eq!(
            (title.as_str(), version, status.as_str(), completed),
            ("Done in Cicada", 2, "done", true)
        );
        assert_eq!(
            tags,
            attributes::with_jira_status("task-sphere:work", "В работе")
        );
        assert_eq!(count(&conn), 1);
    }

    #[test]
    fn a_task_synchronized_from_another_desktop_is_adopted_not_duplicated() {
        let conn = db();
        let id = item_id(SITE, "10001");
        // Arrived through the sync: same deterministic id, renamed there, no local link.
        let tags = attributes::with_jira_status(&new_task_tags(), "В работе");
        conn.execute("INSERT INTO items(id,kind,title,notes,duration_minutes,completed,version,created_at,updated_at,category,color,priority,archived,tags,status) VALUES(?1,'task','Renamed on the other desktop','',0,0,3,?2,?2,'task','#9B9B9B',0,0,?3,'task')", params![id, T0, tags]).unwrap();
        assert_eq!(import(&conn, &[issue("10001", "Jira summary")]), 0);
        assert_eq!(
            (row(&conn, &id).0.as_str(), row(&conn, &id).2),
            ("Renamed on the other desktop", 3)
        );
        assert_eq!(count(&conn), 1);
        let link: String = conn
            .query_row(
                "SELECT last_summary FROM jira_import_links WHERE item_id=?1",
                [&id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(link, "Jira summary");
    }

    #[test]
    fn missing_issues_and_deleted_tasks_are_left_alone() {
        let conn = db();
        import(
            &conn,
            &[issue("10001", "Kept"), issue("10002", "Deleted later")],
        );
        conn.execute("INSERT INTO items(id,kind,title,duration_minutes,version,created_at,updated_at) VALUES('manual','task','Fictional manual task',0,1,'a','a')", []).unwrap();
        // DEMO-1 is done in Jira and leaves the query; the task stays open in Cicada.
        assert_eq!(import(&conn, &[issue("10002", "Deleted later")]), 0);
        assert_eq!(
            (
                row(&conn, &item_id(SITE, "10001")).0.as_str(),
                row(&conn, &item_id(SITE, "10001")).4
            ),
            ("Kept", false)
        );
        // A task deleted in Cicada is not recreated, locally or after a sync tombstone.
        conn.execute("DELETE FROM items WHERE id=?1", [item_id(SITE, "10002")])
            .unwrap();
        assert_eq!(import(&conn, &[issue("10002", "Deleted later")]), 0);
        conn.execute("DELETE FROM jira_import_links", []).unwrap();
        assert_eq!(
            import(&conn, &[issue("10002", "Deleted later")]),
            0,
            "the tombstone of the deletion stands"
        );
        assert_eq!(count(&conn), 2);
        assert_eq!(row(&conn, "manual").0, "Fictional manual task");
    }

    #[test]
    fn pages_follow_the_next_page_token_and_stop_at_the_cap() {
        let body = |ids: std::ops::Range<u32>, next: Option<&str>, last: bool| {
            let issues: Vec<Value> = ids.map(|n| json!({"id":format!("{}", 10000 + n),"key":format!("DEMO-{n}"),"fields":{"summary":format!("Fictional {n}"),"status":{"id":"3","name":"В работе"}}})).collect();
            let mut page = json!({"issues":issues,"isLast":last});
            if let Some(next) = next {
                page["nextPageToken"] = json!(next);
            }
            page.to_string().into_bytes()
        };
        let mut requested = Vec::new();
        let fetched = collect(|token| {
            requested.push(token.map(str::to_owned));
            match token {
                None => parse_page(&body(1..3, Some("page-2"), false)),
                Some("page-2") => parse_page(&body(3..5, None, true)),
                _ => unreachable!(),
            }
        })
        .unwrap();
        assert_eq!(requested, [None, Some("page-2".to_owned())]);
        assert_eq!(
            fetched
                .issues
                .iter()
                .map(|i| i.id.as_str())
                .collect::<Vec<_>>(),
            ["10001", "10002", "10003", "10004"]
        );
        assert!(!fetched.truncated);
        assert_eq!(fetched.issues[0].title, "Fictional 1");
        // isLast wins over a stray token.
        assert!(parse_page(&body(1..2, Some("stray"), true))
            .unwrap()
            .next
            .is_none());
        // More than the cap: the first 500 are applied and the result is marked truncated.
        let mut page_number = 0;
        let capped = collect(|_| {
            page_number += 1;
            parse_page(&body(
                (page_number - 1) * 100 + 1..page_number * 100 + 1,
                Some(&format!("p{page_number}")),
                false,
            ))
        })
        .unwrap();
        assert_eq!(
            (capped.issues.len(), capped.truncated, page_number),
            (MAX_ISSUES, true, 5)
        );
        // A repeated token is a broken response.
        assert_eq!(
            collect(|_| parse_page(&body(1..2, Some("same"), false)))
                .err()
                .unwrap()
                .code,
            "jira_response_invalid"
        );
    }

    #[test]
    fn malformed_or_excess_fields_and_empty_titles_are_rejected() {
        for raw in [
            "",
            "{}",
            r#"{"issues":[{"id":"x1","fields":{"summary":"a"}}]}"#,
            r#"{"issues":[{"id":"10001","fields":{"summary":null,"status":{"id":"3","name":"Open"}}}]}"#,
            r#"{"issues":[{"id":"10001"}]}"#,
            r#"{"issues":[{"id":"10001","fields":{"summary":"  ","status":{"id":"3","name":"Open"}}}]}"#,
            r#"{"issues":[{"id":"10001","fields":{"summary":"a","status":{"id":"3","name":"Open"},"description":"FORBIDDEN-DESCRIPTION"}}]}"#,
            r#"{"issues":[{"id":"10001","fields":{"summary":"a","status":{"id":"3","name":"Open"},"comment":"FORBIDDEN-COMMENT"}}]}"#,
            r#"{"issues":[{"id":"10001","fields":{"summary":"a","status":{"id":"3","name":"Open"},"attachment":[]}}]}"#,
        ] {
            assert_eq!(
                parse_page(raw.as_bytes()).err().unwrap().code,
                "jira_response_invalid"
            );
        }
        assert_eq!(
            clean_title(&"я".repeat(600)).unwrap().chars().count(),
            MAX_TITLE
        );
        assert_eq!(
            clean_title("  Fictional\nrequirement  ").unwrap(),
            "Fictional requirement"
        );
        assert!(clean_title("\t\u{7}  ").is_err());
    }

    #[test]
    fn http_statuses_map_to_distinct_codes() {
        for (status, code) in [
            (301, "jira_redirected"),
            (400, "jira_bad_request"),
            (401, "jira_unauthorized"),
            (403, "jira_forbidden"),
            (404, "jira_not_found"),
            (429, "jira_rate_limited"),
            (500, "jira_server_error"),
            (503, "jira_server_error"),
            (418, "jira_http_error"),
        ] {
            assert_eq!(http_failure(status, None).code, code, "{status}");
        }
        assert_eq!(http_failure(429, Some("120")).retry_after, Some(120));
        assert_eq!(
            http_failure(429, Some("Wed, 21 Oct 2026 07:28:00 GMT")).retry_after,
            None
        );
        assert_eq!(http_failure(401, Some("120")).retry_after, None);
    }

    #[test]
    fn automatic_imports_wait_for_the_interval_and_back_off_after_failures() {
        let now = at(T0);
        assert_eq!(next_attempt(now, 0, None), at("2026-09-25T09:15:00Z"));
        assert_eq!(next_attempt(now, 1, None), at("2026-09-25T09:15:00Z"));
        assert_eq!(next_attempt(now, 2, None), at("2026-09-25T09:30:00Z"));
        assert_eq!(next_attempt(now, 3, None), at("2026-09-25T10:00:00Z"));
        assert_eq!(next_attempt(now, 9, None), at("2026-09-25T13:00:00Z"));
        assert_eq!(next_attempt(now, 1, Some(3600)), at("2026-09-25T10:00:00Z"));
        let db = Mutex::new(db());
        let (runtime, _) = runtime_with(Some(&credential()));
        let fetches = std::cell::Cell::new(0);
        let ok = |_: &Config, _: &Credential| {
            fetches.set(fetches.get() + 1);
            one_issue()
        };
        // Not configured: the tick does nothing, a manual import explains why.
        assert_eq!(run(&db, &runtime, Trigger::Automatic, now, ok).unwrap(), 0);
        assert_eq!(
            run(&db, &runtime, Trigger::Manual, now, ok).unwrap_err(),
            "jira_not_configured"
        );
        save_config(&lock(&db).unwrap(), SITE, "DEMO", TokenMode::Classic, T0).unwrap();
        assert_eq!(run(&db, &runtime, Trigger::Automatic, now, ok).unwrap(), 1);
        assert_eq!(
            run(
                &db,
                &runtime,
                Trigger::Automatic,
                at("2026-09-25T09:14:00Z"),
                ok
            )
            .unwrap(),
            0
        );
        assert_eq!(fetches.get(), 1, "the tick waits 15 minutes");
        assert_eq!(
            run(
                &db,
                &runtime,
                Trigger::Manual,
                at("2026-09-25T09:14:00Z"),
                ok
            )
            .unwrap(),
            0
        );
        assert_eq!(fetches.get(), 2, "a manual import bypasses the interval");
        assert_eq!(
            state(&db)["nextAttempt"],
            "2026-09-25T09:29:00.000Z",
            "15 minutes after the last attempt"
        );
        // A failure is recorded and backs off; data stays.
        let rate_limited = |_: &Config, _: &Credential| {
            Err(Failure {
                code: "jira_rate_limited".into(),
                retry_after: Some(7200),
            })
        };
        run(
            &db,
            &runtime,
            Trigger::Automatic,
            at("2026-09-25T09:30:00Z"),
            rate_limited,
        )
        .unwrap();
        let status = state(&db);
        assert_eq!(
            (
                status["lastError"].as_str(),
                status["nextAttempt"].as_str(),
                status["lastCount"].as_i64()
            ),
            (
                Some("jira_rate_limited"),
                Some("2026-09-25T11:30:00.000Z"),
                Some(1)
            )
        );
        assert_eq!(count(&lock(&db).unwrap()), 1);
        // An unreadable token pauses the import without a request.
        let (blocked, vault) = runtime_with(Some(&credential()));
        vault.unreadable.store(true, Ordering::SeqCst);
        run(
            &db,
            &blocked,
            Trigger::Manual,
            at("2026-09-25T09:31:00Z"),
            ok,
        )
        .unwrap();
        assert_eq!(fetches.get(), 2);
        assert_eq!(state(&db)["lastError"], "jira_token_unavailable");
        // Saving again clears the error and makes the import due at once.
        save_config(&lock(&db).unwrap(), SITE, "DEMO", TokenMode::Classic, T0).unwrap();
        assert_eq!(
            run(
                &db,
                &runtime,
                Trigger::Automatic,
                at("2026-09-25T09:32:00Z"),
                ok
            )
            .unwrap(),
            0
        );
        assert_eq!(fetches.get(), 3);
        let status = state(&db);
        assert_eq!(
            (status["lastError"].clone(), status["lastSuccess"].as_str()),
            (Value::Null, Some("2026-09-25T09:32:00.000Z"))
        );
        // Disabling stops the tick and keeps the imported task.
        disable_config(&lock(&db).unwrap(), T0).unwrap();
        assert_eq!(
            run(
                &db,
                &runtime,
                Trigger::Automatic,
                at("2026-09-25T12:00:00Z"),
                ok
            )
            .unwrap(),
            0
        );
        assert_eq!(fetches.get(), 3);
        assert_eq!(count(&lock(&db).unwrap()), 1);
    }

    #[test]
    fn a_result_is_dropped_when_the_settings_change_during_the_request() {
        let (db, runtime, _) = configured();
        let changed = run(&db, &runtime, Trigger::Manual, at(T0), |_, _| {
            disable_config(&lock(&db).unwrap(), T0).unwrap();
            one_issue()
        })
        .unwrap();
        assert_eq!(changed, 0);
        assert_eq!(count(&lock(&db).unwrap()), 0);
    }

    #[test]
    fn a_saved_token_is_never_sent_to_another_site() {
        let db = Mutex::new(db());
        let (runtime, vault) = runtime_with(None);
        let now = at(T0);
        assert_eq!(
            configure(
                &runtime,
                &db,
                SITE,
                "DEMO",
                "demo@example.com",
                None,
                TokenMode::Classic,
                now
            )
            .unwrap_err(),
            "jira_token_required"
        );
        configure(
            &runtime,
            &db,
            &format!("https://{SITE}/"),
            "demo",
            "demo@example.com",
            Some("fictional-token".into()),
            TokenMode::Classic,
            now,
        )
        .unwrap();
        let saved = vault.stored().unwrap();
        assert_eq!(Credential::parse(&saved).unwrap().site, SITE);
        // Only the site changes: the saved token stays where it was entered.
        assert_eq!(
            configure(
                &runtime,
                &db,
                "other.atlassian.net",
                "DEMO",
                "demo@example.com",
                None,
                TokenMode::Classic,
                now
            )
            .unwrap_err(),
            "jira_token_required_for_site"
        );
        assert_eq!(
            vault.stored().unwrap(),
            saved,
            "the stored credential is unchanged"
        );
        assert_eq!(
            read_config(&lock(&db).unwrap()).unwrap().site,
            SITE,
            "the site setting is unchanged"
        );
        for site in [
            "attacker.example",
            "example.atlassian.net.example.com",
            "example.jira.com",
        ] {
            assert_eq!(
                configure(
                    &runtime,
                    &db,
                    site,
                    "DEMO",
                    "demo@example.com",
                    Some("fictional-token".into()),
                    TokenMode::Classic,
                    now
                )
                .unwrap_err(),
                "jira_site_invalid",
                "{site}"
            );
        }
        assert_eq!(vault.stored().unwrap(), saved);
        // Another email on the same site keeps the token; a new site needs a new token.
        configure(
            &runtime,
            &db,
            SITE,
            "DEMO",
            "other@example.com",
            None,
            TokenMode::Classic,
            now,
        )
        .unwrap();
        let moved = Credential::parse(&vault.stored().unwrap()).unwrap();
        assert_eq!(
            (
                moved.site.as_str(),
                moved.email.as_str(),
                moved.token.as_str()
            ),
            (SITE, "other@example.com", "fictional-token")
        );
        configure(
            &runtime,
            &db,
            "other.atlassian.net",
            "DEMO",
            "other@example.com",
            Some("second-fictional-token".into()),
            TokenMode::Classic,
            now,
        )
        .unwrap();
        assert_eq!(
            Credential::parse(&vault.stored().unwrap()).unwrap().site,
            "other.atlassian.net"
        );
        // A site setting written behind the credential's back is never contacted.
        put_setting(&lock(&db).unwrap(), SITE_KEY, "third.atlassian.net", T0).unwrap();
        let called = std::cell::Cell::new(false);
        run(&db, &runtime, Trigger::Manual, now, |_, _| {
            called.set(true);
            one_issue()
        })
        .unwrap();
        assert!(!called.get());
        assert_eq!(state(&db)["lastError"], "jira_token_required_for_site");
        // A stored credential of the first format has to be entered again.
        let (old, _) = runtime_with(None);
        old.vault
            .write(r#"{"v":1,"email":"demo@example.com","token":"fictional-token"}"#)
            .unwrap();
        assert_eq!(
            configure(
                &old,
                &db,
                SITE,
                "DEMO",
                "demo@example.com",
                None,
                TokenMode::Classic,
                now
            )
            .unwrap_err(),
            "jira_token_unavailable"
        );
    }

    #[test]
    fn a_result_is_dropped_when_the_token_changes_during_the_request() {
        let (db, runtime, _) = configured();
        let changed = run(&db, &runtime, Trigger::Automatic, at(T0), |_, _| {
            runtime
                .save_credential(
                    SITE.into(),
                    "demo@example.com".into(),
                    Some("new-fictional-token".into()),
                    TokenMode::Classic,
                )
                .unwrap();
            Err(http_failure(401, None))
        })
        .unwrap();
        assert_eq!(changed, 0);
        let status = state(&db);
        assert_eq!(
            status["lastError"],
            Value::Null,
            "the old token's 401 is not recorded"
        );
        let failures: i64 = lock(&db)
            .unwrap()
            .query_row("SELECT failures FROM jira_import_state", [], |r| r.get(0))
            .unwrap();
        assert_eq!(failures, 0);
    }

    #[test]
    fn an_import_after_saving_waits_for_the_running_one_and_uses_the_new_token() {
        let (db, runtime, _) = configured();
        let seen = Mutex::new(Vec::new());
        let (started, running) = std::sync::mpsc::channel();
        let (release, released) = std::sync::mpsc::channel::<()>();
        let (runtime, db, seen) = (&runtime, &db, &seen);
        std::thread::scope(|scope| {
            let tick = scope.spawn(move || {
                import_once(runtime, db, Trigger::Automatic, move |_, credential| {
                    seen.lock()
                        .unwrap()
                        .push(("tick", credential.token.clone()));
                    started.send(()).unwrap();
                    released.recv().unwrap();
                    Err(http_failure(401, None))
                })
            });
            running.recv().unwrap();
            // The user saves a new token while the tick still uses the old one.
            configure(
                runtime,
                db,
                SITE,
                "DEMO",
                "demo@example.com",
                Some("new-fictional-token".into()),
                TokenMode::Classic,
                Utc::now(),
            )
            .unwrap();
            let manual = scope.spawn(move || {
                import_once(runtime, db, Trigger::Manual, move |_, credential| {
                    seen.lock()
                        .unwrap()
                        .push(("manual", credential.token.clone()));
                    one_issue()
                })
            });
            // Another tick meanwhile skips instead of queueing.
            assert_eq!(
                import_once(runtime, db, Trigger::Automatic, |_, _| unreachable!()).unwrap(),
                0
            );
            release.send(()).unwrap();
            assert_eq!(tick.join().unwrap().unwrap(), 0);
            assert_eq!(manual.join().unwrap().unwrap(), 1);
        });
        assert_eq!(
            *seen.lock().unwrap(),
            [
                ("tick", "fictional-token".to_owned()),
                ("manual", "new-fictional-token".to_owned())
            ]
        );
        let status = state(db);
        assert_eq!(
            (status["lastError"].clone(), status["lastCount"].as_i64()),
            (Value::Null, Some(1))
        );
        assert_eq!(count(&lock(db).unwrap()), 1);
    }

    #[test]
    fn a_storage_failure_still_moves_the_schedule() {
        let (db, runtime, _) = configured();
        lock(&db).unwrap().execute_batch("CREATE TEMP TRIGGER fictional_failure BEFORE INSERT ON items BEGIN SELECT RAISE(ABORT, 'fictional'); END;").unwrap();
        let fetches = std::cell::Cell::new(0);
        let ok = |_: &Config, _: &Credential| {
            fetches.set(fetches.get() + 1);
            one_issue()
        };
        assert_eq!(
            run(&db, &runtime, Trigger::Automatic, at(T0), ok).unwrap_err(),
            "jira_storage_failed"
        );
        let status = state(&db);
        assert_eq!(
            (
                status["lastError"].as_str(),
                status["nextAttempt"].as_str(),
                status["lastSuccess"].clone()
            ),
            (
                Some("jira_storage_failed"),
                Some("2026-09-25T09:15:00.000Z"),
                Value::Null
            )
        );
        assert_eq!(
            count(&lock(&db).unwrap()),
            0,
            "the failed import is rolled back"
        );
        assert_eq!(
            run(
                &db,
                &runtime,
                Trigger::Automatic,
                at("2026-09-25T09:01:00Z"),
                ok
            )
            .unwrap(),
            0
        );
        assert_eq!(fetches.get(), 1, "the next tick does not call Jira again");
    }

    #[test]
    fn another_site_or_project_starts_with_a_clean_status() {
        let (db, runtime, _) = configured();
        run(&db, &runtime, Trigger::Manual, at(T0), |_, _| one_issue()).unwrap();
        save_config(&lock(&db).unwrap(), SITE, "DEMO", TokenMode::Classic, T0).unwrap();
        assert_eq!(
            state(&db)["lastCount"],
            1,
            "the same settings keep the last result"
        );
        save_config(&lock(&db).unwrap(), SITE, "OTHER", TokenMode::Classic, T0).unwrap();
        let status = state(&db);
        assert_eq!(
            (
                status["lastSuccess"].clone(),
                status["lastCount"].clone(),
                status["lastAttempt"].clone(),
                status["truncated"].clone()
            ),
            (Value::Null, Value::Null, Value::Null, json!(false))
        );
        assert_eq!(count(&lock(&db).unwrap()), 1, "imported tasks stay");
    }

    #[test]
    fn a_failed_token_removal_keeps_disable_available() {
        let (db, runtime, vault) = configured();
        vault.undeletable.store(true, Ordering::SeqCst);
        assert_eq!(
            disable(&runtime, &db, at(T0)).unwrap_err(),
            "jira_token_delete_failed"
        );
        let after = status(&runtime, &db, 0).unwrap();
        assert_eq!(
            (after["enabled"].as_bool(), after["tokenSaved"].as_bool()),
            (Some(false), Some(true))
        );
        vault.undeletable.store(false, Ordering::SeqCst);
        disable(&runtime, &db, at(T0)).unwrap();
        assert_eq!(status(&runtime, &db, 0).unwrap()["tokenSaved"], false);
        assert_eq!(vault.stored(), None);
        // A profile that never configured Jira does not touch the secret store.
        let fresh = Mutex::new(self::db());
        let (untouched, vault) = runtime_with(None);
        assert_eq!(status(&untouched, &fresh, 0).unwrap()["tokenSaved"], false);
        assert_eq!(vault.reads.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn only_titles_status_names_and_generated_identity_enter_storage_and_sync() {
        let conn = db();
        let raw = json!({"issues":[{
            "id":"987654321987654", "key":"SECRET-777",
            "self":"https://private.example/SECRET-LINK",
            "description":"SECRET-DESCRIPTION", "comment":"SECRET-COMMENT",
            "attachment":"SECRET-ATTACHMENT", "assignee":{"emailAddress":"private@example.org"},
            "fields":{"summary":"Approved fictional title","status":{"id":"987651234","name":"В работе","self":"SECRET-STATUS-LINK"}}
        }], "isLast":true});
        let fetched = parse_page(&serde_json::to_vec(&raw).unwrap()).unwrap();
        assert_eq!(import(&conn, &fetched.issues), 1);
        let id = item_id(SITE, "987654321987654");
        let record: String = conn
            .query_row(
                "SELECT data FROM mvp_records WHERE id=?1",
                [json!(["items", [&id]]).to_string()],
                |r| r.get(0),
            )
            .unwrap();
        assert!(record.contains("Approved fictional title"));
        for sentinel in [
            "987654321987654",
            "SECRET-777",
            "SECRET-LINK",
            "SECRET-DESCRIPTION",
            "SECRET-COMMENT",
            "SECRET-ATTACHMENT",
            "private@example.org",
            SITE,
            "fictional-token",
            "987651234",
            "SECRET-STATUS-LINK",
            "task-process",
            "task-stage",
        ] {
            assert!(
                !record.contains(sentinel),
                "forbidden source field in sync: {sentinel}"
            );
        }
        let link: (String, String) = conn
            .query_row(
                "SELECT item_id,last_summary FROM jira_import_links",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(link, (id.clone(), "Approved fictional title".into()));
        let columns: Vec<String> = conn
            .prepare("PRAGMA table_info(jira_import_links)")
            .unwrap()
            .query_map([], |r| r.get(1))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(columns, ["item_id", "last_summary"]);
        assert_eq!(
            row(&conn, &id).1,
            attributes::with_jira_status("task-sphere:work", "В работе")
        );
        let synced: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM mvp_records WHERE id LIKE '%jira_import%'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(synced, 0);
    }
    #[test]
    fn scoped_discovery_has_no_credentials_and_only_search_authenticates() {
        let cloud = "11111111-2222-4333-8444-555555555555";
        let client = client().unwrap();
        let discovery = tenant_request(client, SITE).unwrap();
        assert_eq!(discovery.method(), reqwest::Method::GET);
        assert_eq!(
            discovery.url().as_str(),
            format!("https://{SITE}/_edge/tenant_info")
        );
        assert!(!discovery
            .headers()
            .contains_key(reqwest::header::AUTHORIZATION));
        let cloud_id =
            parse_cloud_id(&serde_json::to_vec(&json!({"cloudId":cloud})).unwrap()).unwrap();
        let mut credential = credential();
        credential.token_mode = TokenMode::Scoped;
        let config = Config {
            site: SITE.into(),
            project: "DEMO".into(),
            token_mode: TokenMode::Scoped,
            enabled: true,
        };
        let request = search_request(
            client,
            &config,
            &credential,
            Some(&cloud_id),
            Some("opaque&cursor"),
        )
        .unwrap();
        assert_eq!(request.method(), reqwest::Method::GET);
        assert_eq!(request.url().host_str(), Some("api.atlassian.com"));
        assert_eq!(
            request.url().path(),
            format!("/ex/jira/{cloud}/rest/api/3/search/jql")
        );
        let query: std::collections::BTreeMap<_, _> =
            request.url().query_pairs().into_owned().collect();
        assert_eq!(query["fields"], "summary,status");
        assert_eq!(query["nextPageToken"], "opaque&cursor");
        assert_eq!(query["jql"], jql("DEMO"));
        assert_eq!(query.len(), 4);
        assert!(request
            .headers()
            .contains_key(reqwest::header::AUTHORIZATION));
        assert!(!request.url().as_str().contains(&credential.token));
        assert!(!request.url().as_str().contains(&credential.email));
    }

    #[test]
    fn classic_search_uses_bound_site_and_never_follows_source_urls() {
        let client = client().unwrap();
        let credential = credential();
        let mut config = Config {
            site: SITE.into(),
            project: "DEMO".into(),
            token_mode: TokenMode::Classic,
            enabled: true,
        };
        let request = search_request(client, &config, &credential, None, None).unwrap();
        assert_eq!(request.url().scheme(), "https");
        assert_eq!(request.url().host_str(), Some(SITE));
        assert_eq!(request.url().path(), "/rest/api/3/search/jql");
        assert_eq!(
            request
                .url()
                .query_pairs()
                .find(|(key, _)| key == "fields")
                .unwrap()
                .1,
            "summary,status"
        );
        config.site = "other.atlassian.net".into();
        assert_eq!(
            search_request(client, &config, &credential, None, None)
                .unwrap_err()
                .code,
            "jira_token_required_for_site"
        );
        config.site = SITE.into();
        config.token_mode = TokenMode::Scoped;
        assert_eq!(
            search_request(client, &config, &credential, None, None)
                .unwrap_err()
                .code,
            "jira_token_required_for_mode"
        );
        for site in [
            "localhost",
            "example.atlassian.net.evil.test",
            "example.atlassian.net:443",
            "user@example.atlassian.net",
        ] {
            assert!(tenant_request(client, site).is_err());
        }
        for raw in [
            r#"{}"#,
            r#"{"cloudId":"../../elsewhere"}"#,
            r#"{"cloudId":"https://evil.test"}"#,
            r#"{"cloudId":null}"#,
        ] {
            assert_eq!(
                parse_cloud_id(raw.as_bytes()).unwrap_err().code,
                "jira_cloud_id_invalid"
            );
        }
    }

    #[test]
    fn token_mode_defaults_to_scoped_and_cannot_reuse_a_different_binding() {
        let fresh = db();
        assert_eq!(read_config(&fresh).unwrap().token_mode, TokenMode::Scoped);
        assert_eq!(
            status_value(&fresh, None, false, 0).unwrap()["tokenMode"],
            "scoped"
        );
        let (db, runtime, vault) = configured();
        let saved = vault.stored().unwrap();
        assert_eq!(
            configure(
                &runtime,
                &db,
                SITE,
                "DEMO",
                "demo@example.com",
                None,
                TokenMode::Scoped,
                at(T0)
            )
            .unwrap_err(),
            "jira_token_required_for_mode"
        );
        assert_eq!(vault.stored().unwrap(), saved);
        assert_eq!(
            read_config(&lock(&db).unwrap()).unwrap().token_mode,
            TokenMode::Classic
        );
        configure(
            &runtime,
            &db,
            SITE,
            "DEMO",
            "demo@example.com",
            Some("scoped-fictional-token".into()),
            TokenMode::Scoped,
            at(T0),
        )
        .unwrap();
        assert_eq!(
            Credential::parse(&vault.stored().unwrap())
                .unwrap()
                .token_mode,
            TokenMode::Scoped
        );
        assert_eq!(state(&db)["tokenMode"], "scoped");
        put_setting(&lock(&db).unwrap(), TOKEN_MODE_KEY, "classic", T0).unwrap();
        let called = std::cell::Cell::new(false);
        run(&db, &runtime, Trigger::Manual, at(T0), |_, _| {
            called.set(true);
            one_issue()
        })
        .unwrap();
        assert!(!called.get());
        assert_eq!(state(&db)["lastError"], "jira_token_required_for_mode");
        let conn = lock(&db).unwrap();
        let all_sync: Vec<String> = conn
            .prepare("SELECT data FROM mvp_records")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        let sqlite_settings: Vec<String> = conn
            .prepare("SELECT value FROM app_settings")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        for value in all_sync.iter().chain(sqlite_settings.iter()) {
            assert!(!value.contains("demo@example.com") && !value.contains("fictional-token"));
        }
    }

    #[test]
    fn a_later_page_with_forbidden_fields_stores_no_partial_import_or_response() {
        let (db, runtime, _) = configured();
        let changed = run(&db, &runtime, Trigger::Manual, at(T0), |_,_| {
            collect(|cursor| {
                if cursor.is_none() {
                    parse_page(br#"{"issues":[{"id":"10001","fields":{"summary":"Approved","status":{"id":"3","name":"Open"}}}],"nextPageToken":"next"}"#)
                } else {
                    parse_page(br#"{"issues":[{"id":"10002","fields":{"summary":"Approved too","status":{"id":"3","name":"Open"},"description":"PRIVATE-CONTENT"}}],"isLast":true}"#)
                }
            })
        }).unwrap();
        assert_eq!(changed, 0);
        assert_eq!(count(&lock(&db).unwrap()), 0);
        let status = state(&db);
        assert_eq!(status["lastError"], "jira_response_invalid");
        assert!(!status.to_string().contains("PRIVATE-CONTENT"));
    }
    struct FakeTaskApi {
        current: Issue,
        included: bool,
        transitions: Vec<Transition>,
        calls: Vec<&'static str>,
        write_error: bool,
        fail_readback: bool,
    }
    impl FakeTaskApi {
        fn new() -> Self {
            Self {
                current: issue("10001", "Fictional"),
                included: true,
                transitions: vec![Transition {
                    id: "31".into(),
                    name: "Finish".into(),
                    status: "Готово".into(),
                }],
                calls: vec![],
                write_error: false,
                fail_readback: false,
            }
        }
    }
    impl TaskApi for FakeTaskApi {
        fn project_issues(&mut self) -> Result<Fetched, Failure> {
            self.calls.push("project");
            Ok(Fetched {
                issues: if self.included {
                    vec![self.current.clone()]
                } else {
                    vec![]
                },
                truncated: false,
            })
        }
        fn read_issue(&mut self, id: &str) -> Result<Issue, Failure> {
            assert_eq!(id, self.current.id);
            self.calls.push("read");
            if self.fail_readback
                && self
                    .calls
                    .iter()
                    .any(|call| matches!(*call, "rename" | "transition"))
            {
                return Err(failure("jira_timeout"));
            }
            Ok(self.current.clone())
        }
        fn transitions(&mut self, id: &str) -> Result<Vec<Transition>, Failure> {
            assert_eq!(id, self.current.id);
            self.calls.push("transitions");
            Ok(self.transitions.clone())
        }
        fn rename(&mut self, id: &str, title: &str) -> Result<(), Failure> {
            assert_eq!(id, self.current.id);
            self.calls.push("rename");
            self.current.title = title.into();
            if self.write_error {
                Err(failure("jira_write_outcome_unknown"))
            } else {
                Ok(())
            }
        }
        fn transition(&mut self, id: &str, transition: &str) -> Result<(), Failure> {
            assert_eq!(id, self.current.id);
            self.calls.push("transition");
            self.current.status = self
                .transitions
                .iter()
                .find(|entry| entry.id == transition)
                .unwrap()
                .status
                .clone();
            if self.write_error {
                Err(failure("jira_write_outcome_unknown"))
            } else {
                Ok(())
            }
        }
    }
    fn editable_fixture() -> (Mutex<Connection>, Config, String, FakeTaskApi) {
        let (db, _, _) = configured();
        let config = read_config(&lock(&db).unwrap()).unwrap();
        let api = FakeTaskApi::new();
        import(&lock(&db).unwrap(), &[api.current.clone()]);
        (db, config, item_id(SITE, "10001"), api)
    }

    #[test]
    fn full_project_includes_done_without_completing_local_tasks() {
        assert_eq!(jql("PL"), "project = \"PL\" ORDER BY updated DESC");
        let body = json!({"issues":[
            {"id":"1","fields":{"summary":"Other assignee","status":{"id":"2","name":"В работе","statusCategory":{"key":"indeterminate"}}}},
            {"id":"2","fields":{"summary":"Completed in Jira","status":{"id":"3","name":"Готово","statusCategory":{"key":"done"}}}}
        ],"isLast":true});
        let page = parse_page(&serde_json::to_vec(&body).unwrap()).unwrap();
        let conn = db();
        assert_eq!(import(&conn, &page.issues), 2);
        for issue in &page.issues {
            let task = row(&conn, &item_id(SITE, &issue.id));
            assert_eq!(task.3, "task");
            assert!(!task.4);
            assert_eq!(
                attributes::jira_status(&task.1).as_deref(),
                Some(issue.status.as_str())
            );
            assert_eq!(attributes::process(&task.1), None);
        }
    }

    #[test]
    fn source_status_requires_id_and_name_and_ignores_normal_metadata() {
        for status in [
            json!(null),
            json!({}),
            json!({"id":"2","name":""}),
            json!({"id":"2","name":"a\nb"}),
            json!({"id":"../../x","name":"Open"}),
        ] {
            let body = json!({"issues":[{"id":"1","fields":{"summary":"Title","status":status}}]});
            assert_eq!(
                parse_page(&serde_json::to_vec(&body).unwrap())
                    .err()
                    .unwrap()
                    .code,
                "jira_response_invalid"
            );
        }
        let body = json!({"transitions":[
            {"id":"31","name":"Finish","to":{"id":"999876","name":"Готово","self":"SECRET-LINK","iconUrl":"SECRET-ICON","statusCategory":{"name":"Done"}}},
            {"id":"32","name":"Unavailable","isAvailable":false,"to":{"id":"3","name":"Blocked"}}
        ]});
        let transitions = parse_transitions(&serde_json::to_vec(&body).unwrap()).unwrap();
        assert_eq!(
            transitions,
            vec![Transition {
                id: "31".into(),
                name: "Finish".into(),
                status: "Готово".into()
            }]
        );
        let safe = serde_json::to_string(&transitions).unwrap();
        for forbidden in ["999876", "SECRET", "icon", "category"] {
            assert!(!safe.contains(forbidden));
        }
        assert!(parse_transitions(br#"{"transitions":[{"id":"1","name":"Go","to":{"id":"3","name":"X"}},{"id":"1","name":"Other","to":{"id":"4","name":"Y"}}]}"#).is_err());
    }

    #[test]
    fn write_requests_are_typed_and_bound_to_the_configured_tenant() {
        let (_, config, _, _) = editable_fixture();
        let credential = credential();
        let client = client().unwrap();
        let rename = issue_request(
            client,
            &config,
            &credential,
            None,
            "10001",
            IssueRequest::Rename("New title"),
        )
        .unwrap();
        assert_eq!(rename.method(), reqwest::Method::PUT);
        assert_eq!(
            rename.url().as_str(),
            format!("https://{SITE}/rest/api/3/issue/10001")
        );
        let body: Value =
            serde_json::from_slice(rename.body().unwrap().as_bytes().unwrap()).unwrap();
        assert_eq!(body, json!({"fields":{"summary":"New title"}}));
        let transition = issue_request(
            client,
            &config,
            &credential,
            None,
            "10001",
            IssueRequest::Transition("31"),
        )
        .unwrap();
        assert_eq!(transition.method(), reqwest::Method::POST);
        assert_eq!(
            transition.url().path(),
            "/rest/api/3/issue/10001/transitions"
        );
        let body: Value =
            serde_json::from_slice(transition.body().unwrap().as_bytes().unwrap()).unwrap();
        assert_eq!(body, json!({"transition":{"id":"31"}}));
        let read = issue_request(
            client,
            &config,
            &credential,
            None,
            "10001",
            IssueRequest::Read,
        )
        .unwrap();
        assert_eq!(
            read.url().query_pairs().collect::<Vec<_>>(),
            vec![("fields".into(), "summary,status".into())]
        );
        assert!(issue_request(
            client,
            &config,
            &credential,
            None,
            "../../other",
            IssueRequest::Read
        )
        .is_err());
        assert!(issue_request(
            client,
            &config,
            &credential,
            None,
            "10001",
            IssueRequest::Transition("31?x=1")
        )
        .is_err());
        let mut scoped_config = config.clone();
        scoped_config.token_mode = TokenMode::Scoped;
        let mut scoped_credential = credential.clone();
        scoped_credential.token_mode = TokenMode::Scoped;
        let request = issue_request(
            client,
            &scoped_config,
            &scoped_credential,
            Some("11111111-2222-4333-8444-555555555555"),
            "10001",
            IssueRequest::Rename("Scoped"),
        )
        .unwrap();
        assert_eq!(request.url().host_str(), Some("api.atlassian.com"));
        assert_eq!(
            request.url().path(),
            "/ex/jira/11111111-2222-4333-8444-555555555555/rest/api/3/issue/10001"
        );
        scoped_config.site = "other.atlassian.net".into();
        assert_eq!(
            issue_request(
                client,
                &scoped_config,
                &scoped_credential,
                None,
                "10001",
                IssueRequest::Read
            )
            .unwrap_err()
            .code,
            "jira_token_required_for_site"
        );
    }

    #[test]
    fn writes_resolve_membership_and_reject_conflicts_or_forged_transitions() {
        let (db, config, id, mut api) = editable_fixture();
        api.included = false;
        assert_eq!(
            perform_task(
                &db,
                &config,
                &id,
                TaskAction::Rename {
                    title: "New".into(),
                    expected_title: "Fictional".into()
                },
                &mut api
            )
            .unwrap_err(),
            "jira_task_not_found"
        );
        assert_eq!(api.calls, ["project"]);
        api.included = true;
        api.calls.clear();
        assert_eq!(
            perform_task(
                &db,
                &config,
                &id,
                TaskAction::Rename {
                    title: "New".into(),
                    expected_title: "Stale".into()
                },
                &mut api
            )
            .unwrap_err(),
            "jira_task_conflict"
        );
        assert_eq!(api.calls, ["project", "read", "transitions"]);
        api.calls.clear();
        assert_eq!(
            perform_task(
                &db,
                &config,
                &id,
                TaskAction::Transition {
                    id: "31".into(),
                    expected_status: "Stale".into()
                },
                &mut api
            )
            .unwrap_err(),
            "jira_task_conflict"
        );
        assert_eq!(api.calls, ["project", "read", "transitions"]);
        api.calls.clear();
        assert_eq!(
            perform_task(
                &db,
                &config,
                &id,
                TaskAction::Transition {
                    id: "999".into(),
                    expected_status: "В работе".into()
                },
                &mut api
            )
            .unwrap_err(),
            "jira_transition_invalid"
        );
        assert_eq!(api.calls, ["project", "read", "transitions"]);
        api.calls.clear();
        assert_eq!(
            perform_task(
                &db,
                &config,
                "https://foreign.test/issue/10001",
                TaskAction::Details,
                &mut api
            )
            .unwrap_err(),
            "jira_task_not_found"
        );
        assert!(api.calls.is_empty());
    }

    #[test]
    fn stale_project_search_cannot_authorize_a_moved_issue() {
        let (db, config, id, mut api) = editable_fixture();
        let body = json!({"id":"10001","key":"OTHER-72","fields":{"summary":"Fictional","status":{"id":"3","name":"В работе"}}});
        api.current = decode_issue(serde_json::from_value(body).unwrap()).unwrap();
        assert_eq!(
            perform_task(
                &db,
                &config,
                &id,
                TaskAction::Rename {
                    title: "New".into(),
                    expected_title: "Fictional".into()
                },
                &mut api
            )
            .unwrap_err(),
            "jira_task_not_found"
        );
        assert_eq!(api.calls, ["project", "read"]);
        api.calls.clear();
        assert_eq!(
            perform_task(
                &db,
                &config,
                &id,
                TaskAction::Transition {
                    id: "31".into(),
                    expected_status: "В работе".into()
                },
                &mut api
            )
            .unwrap_err(),
            "jira_task_not_found"
        );
        assert_eq!(api.calls, ["project", "read"]);
        for key in [
            None,
            Some("PL-not-numeric"),
            Some("https://outside.test/PL-1"),
        ] {
            let body = json!({"id":"10001","key":key,"fields":{"summary":"Fictional","status":{"id":"3","name":"В работе"}}});
            api.current = decode_issue(serde_json::from_value(body).unwrap()).unwrap();
            assert_eq!(
                read_project_issue(&mut api, "10001", "PL")
                    .err()
                    .unwrap()
                    .code,
                "jira_task_not_found"
            );
        }
        let body = json!({"id":"10001","key":"PL-72","fields":{"summary":"Fictional","status":{"id":"3","name":"В работе"}}});
        api.current = decode_issue(serde_json::from_value(body).unwrap()).unwrap();
        assert!(read_project_issue(&mut api, "10001", "PL").is_ok());
    }

    #[test]
    fn confirmed_actions_read_back_and_refresh_safe_local_state() {
        let (db, config, id, mut api) = editable_fixture();
        let renamed = perform_task(
            &db,
            &config,
            &id,
            TaskAction::Rename {
                title: "Renamed".into(),
                expected_title: "Fictional".into(),
            },
            &mut api,
        )
        .unwrap();
        assert_eq!(
            (
                renamed.title.as_str(),
                renamed.status.as_str(),
                renamed.changed,
                renamed.editable
            ),
            ("Renamed", "В работе", 1, true)
        );
        assert_eq!(
            api.calls,
            [
                "project",
                "read",
                "transitions",
                "rename",
                "read",
                "transitions"
            ]
        );
        assert_eq!(row(&lock(&db).unwrap(), &id).0, "Renamed");
        api.calls.clear();
        let transitioned = perform_task(
            &db,
            &config,
            &id,
            TaskAction::Transition {
                id: "31".into(),
                expected_status: "В работе".into(),
            },
            &mut api,
        )
        .unwrap();
        assert_eq!(
            (transitioned.status.as_str(), transitioned.changed),
            ("Готово", 1)
        );
        assert_eq!(
            api.calls,
            [
                "project",
                "read",
                "transitions",
                "transition",
                "read",
                "transitions"
            ]
        );
        let task = row(&lock(&db).unwrap(), &id);
        assert_eq!(attributes::jira_status(&task.1).as_deref(), Some("Готово"));
        assert_eq!((task.3.as_str(), task.4), ("task", false));
        let serialized = serde_json::to_value(transitioned).unwrap();
        assert_eq!(
            serialized
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            ["changed", "editable", "status", "title", "transitions"]
        );
        assert!(!serialized.to_string().contains("10001"));
        assert!(!serialized.to_string().contains(SITE));
    }

    #[test]
    fn unknown_write_is_not_replayed_and_details_can_reconcile_it() {
        let (db, config, id, mut api) = editable_fixture();
        api.write_error = true;
        assert_eq!(
            perform_task(
                &db,
                &config,
                &id,
                TaskAction::Rename {
                    title: "Applied before timeout".into(),
                    expected_title: "Fictional".into()
                },
                &mut api
            )
            .unwrap_err(),
            "jira_write_outcome_unknown"
        );
        assert_eq!(api.calls, ["project", "read", "transitions", "rename"]);
        assert_eq!(row(&lock(&db).unwrap(), &id).0, "Fictional");
        let refreshed = perform_task(&db, &config, &id, TaskAction::Details, &mut api).unwrap();
        assert_eq!(
            (refreshed.title.as_str(), refreshed.changed),
            ("Applied before timeout", 1)
        );
        assert_eq!(
            api.calls.iter().filter(|call| **call == "rename").count(),
            1
        );
        assert_eq!(row(&lock(&db).unwrap(), &id).0, "Applied before timeout");
        for status in [202, 409, 500, 502, 503, 504] {
            assert_eq!(
                write_status(status, None).unwrap_err().code,
                "jira_write_outcome_unknown"
            );
        }
        assert_eq!(
            write_status(400, None).unwrap_err().code,
            "jira_bad_request"
        );
        assert_eq!(write_status(403, None).unwrap_err().code, "jira_forbidden");
        assert_eq!(
            write_status(429, Some("60")).unwrap_err(),
            http_failure(429, Some("60"))
        );
        let (db, config, id, mut api) = editable_fixture();
        api.fail_readback = true;
        assert_eq!(
            perform_task(
                &db,
                &config,
                &id,
                TaskAction::Transition {
                    id: "31".into(),
                    expected_status: "В работе".into()
                },
                &mut api
            )
            .unwrap_err(),
            "jira_write_outcome_unknown"
        );
        assert_eq!(
            api.calls,
            ["project", "read", "transitions", "transition", "read"]
        );
    }

    #[test]
    fn details_and_mutations_preserve_manual_title_completion_process_and_timers() {
        let (db, config, id, mut api) = editable_fixture();
        let tags = "personal-tag,task-sphere:home,task-process:local-process,task-stage:review,task-stage-log:review@2026-09-25T09:00:00Z,task-waiting";
        {
            let conn = lock(&db).unwrap();
            conn.execute("UPDATE items SET title='My local title',status='done',completed=1,tags=?1 WHERE id=?2",params![tags,id]).unwrap();
            conn.execute("INSERT INTO timeline_blocks(source_type,source_id,date,start_time,is_active,completion_date,created_at,updated_at) VALUES('note',?1,'2026-09-25','09:00:00',1,'2026-09-25',?2,?2)",params![id,T0]).unwrap();
        }
        let remote = perform_task(
            &db,
            &config,
            &id,
            TaskAction::Rename {
                title: "Remote new title".into(),
                expected_title: "Fictional".into(),
            },
            &mut api,
        )
        .unwrap();
        assert_eq!(remote.title, "Remote new title");
        let transitioned = perform_task(
            &db,
            &config,
            &id,
            TaskAction::Transition {
                id: "31".into(),
                expected_status: "В работе".into(),
            },
            &mut api,
        )
        .unwrap();
        assert_eq!(transitioned.status, "Готово");
        let conn = lock(&db).unwrap();
        let task = row(&conn, &id);
        assert_eq!(
            (task.0.as_str(), task.3.as_str(), task.4),
            ("My local title", "done", true)
        );
        assert_eq!(task.1, attributes::with_jira_status(tags, "Готово"));
        assert_eq!(
            conn.query_row(
                "SELECT is_active FROM timeline_blocks WHERE source_id=?1",
                [&id],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
    }
}

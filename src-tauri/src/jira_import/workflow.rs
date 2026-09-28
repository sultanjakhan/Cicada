//! Project-local, explicitly chosen meanings of Jira status names. Catalog data
//! is projected before storage; neither category nor status IDs imply a role.
use super::*;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Ready,
    Working,
    Review,
    Completed,
    Hidden,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Mapping {
    name: String,
    bucket: Option<Role>,
}

#[derive(Default)]
struct Rules {
    version: i64,
    mappings: BTreeMap<String, Role>,
    default_process: Option<String>,
}
impl Rules {
    fn revision(&self, scope: &str) -> String {
        hex::encode(Sha256::digest(
            format!("{scope}\n{}", self.version).as_bytes(),
        ))
    }
    fn role(&self, status: &str) -> Option<Role> {
        self.mappings.get(status).copied()
    }
}

pub(super) fn initialize(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS jira_workflow_rules (
        scope_hash TEXT PRIMARY KEY, revision INTEGER NOT NULL, mappings TEXT NOT NULL,
        default_process TEXT);
        CREATE TABLE IF NOT EXISTS jira_workflow_catalog (scope_hash TEXT PRIMARY KEY, names TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS jira_workflow_members (item_id TEXT PRIMARY KEY, scope_hash TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS jira_workflow_members_scope ON jira_workflow_members(scope_hash);")
        .map_err(storage)
}

fn read_rules(conn: &Connection, scope: &str) -> Result<Rules, String> {
    let row: Option<(i64, String, Option<String>)> = conn
        .query_row(
            "SELECT revision,mappings,default_process FROM jira_workflow_rules WHERE scope_hash=?1",
            [scope],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(storage)?;
    match row {
        Some((version, mappings, default_process)) => Ok(Rules {
            version,
            mappings: serde_json::from_str(&mappings).map_err(storage)?,
            default_process,
        }),
        None => Ok(Rules::default()),
    }
}

#[derive(Deserialize)]
struct CatalogType {
    statuses: Vec<StatusBody>,
}
fn parse_catalog(body: &[u8]) -> Result<Vec<String>, Failure> {
    let types: Vec<CatalogType> =
        serde_json::from_slice(body).map_err(|_| failure("jira_response_invalid"))?;
    if types.len() > 1000 || types.iter().map(|t| t.statuses.len()).sum::<usize>() > 10000 {
        return Err(failure("jira_response_invalid"));
    }
    let mut names = BTreeSet::new();
    for kind in types {
        for status in kind.statuses {
            names.insert(status_name(status)?);
        }
    }
    Ok(names.into_iter().collect())
}
fn catalog_request(api: &HttpTaskApi<'_>) -> Result<reqwest::blocking::Request, Failure> {
    let base = api_base(api.config, api.credential, api.cloud_id.as_deref())?;
    api.client
        .get(format!(
            "{base}/rest/api/3/project/{}/statuses",
            api.config.project
        ))
        .basic_auth(&api.credential.email, Some(&api.credential.token))
        .header(reqwest::header::ACCEPT, "application/json")
        .build()
        .map_err(|_| failure("jira_network_unavailable"))
}
fn store_catalog(conn: &Connection, scope: &str, names: &[String]) -> Result<(), String> {
    conn.execute(
        "INSERT INTO jira_workflow_catalog(scope_hash,names) VALUES(?1,?2)
        ON CONFLICT(scope_hash) DO UPDATE SET names=excluded.names",
        params![scope, serde_json::to_string(names).map_err(storage)?],
    )
    .map_err(storage)?;
    Ok(())
}
fn catalog(conn: &Connection, scope: &str) -> Result<Vec<String>, String> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT names FROM jira_workflow_catalog WHERE scope_hash=?1",
            [scope],
            |r| r.get(0),
        )
        .optional()
        .map_err(storage)?;
    serde_json::from_str(&raw.ok_or("jira_workflow_catalog_required")?).map_err(storage)
}
fn snapshot(conn: &Connection, config: &Config) -> Result<Value, String> {
    let scope = create_scope(config);
    let rules = read_rules(conn, &scope)?;
    let statuses: Vec<_> = catalog(conn, &scope)?
        .into_iter()
        .map(|name| {
            let bucket = rules.role(&name);
            Mapping { name, bucket }
        })
        .collect();
    Ok(
        json!({"scope":scope,"revision":rules.revision(&scope),"project":config.project,
        "statuses":statuses,"defaultProcessId":rules.default_process}),
    )
}
fn require_config(conn: &Connection) -> Result<Config, String> {
    let config = read_config(conn)?;
    if !config.ready() {
        return Err("jira_not_configured".into());
    }
    Ok(config)
}
fn bound_credential(runtime: &Runtime, config: &Config) -> Result<Credential, String> {
    let credential = runtime.credential()?.ok_or("jira_token_required")?;
    if credential.site != config.site {
        return Err("jira_token_required_for_site".into());
    }
    if credential.token_mode != config.token_mode {
        return Err("jira_token_required_for_mode".into());
    }
    Ok(credential)
}

#[tauri::command]
pub async fn jira_workflow_options(app: tauri::AppHandle) -> Result<Value, String> {
    blocking(app, |app| {
        let runtime = app.state::<Runtime>();
        let _running = runtime
            .import
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let db = &app.state::<crate::AppState>().0;
        let config = require_config(&*lock(db)?)?;
        let credential = bound_credential(&runtime, &config)?;
        let api = HttpTaskApi::new(&config, &credential).map_err(|e| e.code)?;
        let names = parse_catalog(
            &read_response(
                api.client,
                catalog_request(&api).map_err(|e| e.code)?,
                MAX_BODY,
            )
            .map_err(|e| e.code)?,
        )
        .map_err(|e| e.code)?;
        let conn = lock(db)?;
        if read_config(&conn)? != config {
            return Err("jira_workflow_conflict".into());
        }
        store_catalog(&conn, &create_scope(&config), &names)?;
        snapshot(&conn, &config)
    })
    .await
}

fn validate_process(conn: &Connection, process: Option<&str>) -> Result<(), String> {
    let Some(process) = process else {
        return Ok(());
    };
    if !attributes::valid_id(process) {
        return Err("jira_workflow_process_invalid".into());
    }
    if process == attributes::DEFAULT_PROCESS {
        return Ok(());
    }
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM ui_state WHERE key='calendar_processes_v1'",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(storage)?;
    let state: Value = raw
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
        .map_err(storage)?
        .unwrap_or(Value::Null);
    if !state["processes"]
        .as_array()
        .is_some_and(|rows| rows.iter().any(|r| r["id"] == process))
    {
        return Err("jira_workflow_process_invalid".into());
    }
    Ok(())
}
pub(super) fn default_process(
    conn: &Connection,
    config: &Config,
) -> Result<Option<String>, String> {
    let process = read_rules(conn, &create_scope(config))?.default_process;
    // A process can be deleted independently on another device. Never recreate it.
    match validate_process(conn, process.as_deref()) {
        Err(code) if code == "jira_workflow_process_invalid" => return Ok(None),
        Err(code) => return Err(code),
        Ok(()) => {}
    }
    Ok(process)
}
fn assign_process(conn: &Connection, id: &str, process: &str, now: &str) -> Result<(), String> {
    let row: Option<(String,String)> = conn.query_row(
        "SELECT tags,created_at FROM items WHERE id=?1 AND kind='task' AND status IN ('task','done')",
        [id], |r| Ok((r.get(0)?,r.get(1)?))).optional().map_err(storage)?;
    if let Some((tags, since)) =
        row.filter(|(tags, _)| attributes::effective_process(tags).is_none())
    {
        let next = attributes::edit_stage(
            &tags,
            attributes::StageEdit {
                process: Some(process),
                ..Default::default()
            },
            now,
            &since,
        );
        conn.execute(
            "UPDATE items SET tags=?1,version=version+1,updated_at=?2 WHERE id=?3",
            params![next, now, id],
        )
        .map_err(storage)?;
    }
    Ok(())
}
fn save_rules(
    conn: &mut Connection,
    config: &Config,
    scope: &str,
    expected: &str,
    mappings: Vec<Mapping>,
    default_process: Option<String>,
    apply_existing: bool,
) -> Result<Value, String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(storage)?;
    if scope != create_scope(config) || read_config(&tx)? != *config {
        return Err("jira_workflow_conflict".into());
    }
    let previous = read_rules(&tx, scope)?;
    if previous.revision(scope) != expected {
        return Err("jira_workflow_conflict".into());
    }
    validate_process(&tx, default_process.as_deref())?;
    let known: BTreeSet<_> = catalog(&tx, scope)?.into_iter().collect();
    if mappings.len() > known.len() {
        return Err("jira_workflow_mapping_invalid".into());
    }
    let mut seen = BTreeSet::new();
    let mut next = BTreeMap::new();
    for entry in mappings {
        if !known.contains(&entry.name) || !seen.insert(entry.name.clone()) {
            return Err("jira_workflow_mapping_invalid".into());
        }
        if let Some(role) = entry.bucket {
            next.insert(entry.name, role);
        }
    }
    tx.execute("INSERT INTO jira_workflow_rules(scope_hash,revision,mappings,default_process) VALUES(?1,?2,?3,?4)
        ON CONFLICT(scope_hash) DO UPDATE SET revision=excluded.revision,mappings=excluded.mappings,default_process=excluded.default_process",
        params![scope,previous.version.checked_add(1).ok_or("jira_storage_failed")?,serde_json::to_string(&next).map_err(storage)?,default_process]).map_err(storage)?;
    if let Some(process) = default_process.as_deref().filter(|_| apply_existing) {
        let ids = {
            let mut stmt = tx
                .prepare("SELECT item_id FROM jira_workflow_members WHERE scope_hash=?1")
                .map_err(storage)?;
            let rows = stmt
                .query_map([scope], |r| r.get::<_, String>(0))
                .map_err(storage)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(storage)?
        };
        let at = stamp(Utc::now());
        for id in ids {
            assign_process(&tx, &id, process, &at)?;
        }
    }
    let result = snapshot(&tx, config)?;
    tx.commit().map_err(storage)?;
    Ok(result)
}
#[tauri::command(rename_all = "camelCase")]
pub async fn jira_workflow_save(
    app: tauri::AppHandle,
    scope: String,
    expected_revision: String,
    mappings: Vec<Mapping>,
    default_process_id: Option<String>,
    apply_to_existing: bool,
) -> Result<Value, String> {
    blocking(app, move |app| {
        let runtime = app.state::<Runtime>();
        let _running = runtime
            .import
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let state = app.state::<crate::AppState>();
        let mut conn = lock(&state.0)?;
        let config = require_config(&conn)?;
        save_rules(
            &mut conn,
            &config,
            &scope,
            &expected_revision,
            mappings,
            default_process_id,
            apply_to_existing,
        )
    })
    .await
}

/// Called only after a successful fetch, inside the same transaction as import.
pub(super) fn apply_confirmed(
    conn: &Connection,
    config: &Config,
    issues: &[Issue],
    now: &str,
) -> Result<usize, String> {
    let before: BTreeMap<String, Option<i64>> = issues
        .iter()
        .map(|issue| item_id(&config.site, &issue.id))
        .map(|id| {
            conn.query_row("SELECT version FROM items WHERE id=?1 AND kind='task' AND status IN ('task','done')",[&id],|r| r.get(0))
                .optional().map(|version| (id,version)).map_err(storage)
        }).collect::<Result<_,_>>()?;
    let mut changed = apply(conn, &config.site, issues, now)?;
    let scope = create_scope(config);
    let process = default_process(conn, config)?;
    for issue in issues {
        if issue.project.as_deref() != Some(config.project.as_str()) {
            continue;
        }
        let id = item_id(&config.site, &issue.id);
        if !local_task_exists(conn, &id)? {
            continue;
        }
        let membership_changed = conn
            .execute(
                "INSERT INTO jira_workflow_members(item_id,scope_hash) VALUES(?1,?2)
            ON CONFLICT(item_id) DO UPDATE SET scope_hash=excluded.scope_hash
            WHERE jira_workflow_members.scope_hash<>excluded.scope_hash",
                params![id, scope],
            )
            .map_err(storage)?;
        if membership_changed > 0 {
            if let Some(previous) = before.get(&id).copied().flatten() {
                let current: i64 = conn
                    .query_row("SELECT version FROM items WHERE id=?1", [&id], |r| r.get(0))
                    .map_err(storage)?;
                // Count a membership-only refresh without counting an item twice.
                if current == previous {
                    changed += membership_changed;
                }
            }
        }
        if let Some(process) = process
            .as_deref()
            .filter(|_| before.get(&id) == Some(&None))
        {
            assign_process(conn, &id, process, now)?;
        }
    }
    Ok(changed)
}

pub(crate) fn decorate_records(conn: &Connection, rows: &mut [Value]) -> Result<(), String> {
    if !rows.iter().any(|r| {
        r["source_id"]
            .as_str()
            .or_else(|| r["id"].as_str())
            .is_some_and(|id| id.starts_with(ID_PREFIX))
    }) {
        return Ok(());
    }
    let mut stmt = conn
        .prepare("SELECT item_id,scope_hash FROM jira_workflow_members")
        .map_err(storage)?;
    let members = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(storage)?
        .collect::<Result<BTreeMap<_, _>, _>>()
        .map_err(storage)?;
    let mut rules = BTreeMap::new();
    for scope in members.values() {
        if !rules.contains_key(scope) {
            rules.insert(scope.clone(), read_rules(conn, scope)?);
        }
    }
    for row in rows {
        let Some(id) = row["source_id"]
            .as_str()
            .or_else(|| row["id"].as_str())
            .filter(|id| id.starts_with(ID_PREFIX))
        else {
            continue;
        };
        let scope = members.get(id);
        let rule = scope.and_then(|s| rules.get(s));
        let role = rule.and_then(|r| row["jira_status"].as_str().and_then(|name| r.role(name)));
        let revision = scope.zip(rule).map(|(scope, rule)| rule.revision(scope));
        row["jira_workflow_role"] = role.map(|v| json!(v)).unwrap_or(json!("unassigned"));
        row["jira_workflow_scope"] = json!(scope);
        row["jira_workflow_revision"] = json!(revision);
    }
    Ok(())
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Start,
    Finish,
    Review,
}
impl Action {
    fn target(self) -> Role {
        match self {
            Self::Start => Role::Working,
            Self::Finish => Role::Completed,
            Self::Review => Role::Review,
        }
    }
    fn accepts(self, role: Role) -> bool {
        match self {
            Self::Start => matches!(role, Role::Ready | Role::Working),
            _ => matches!(role, Role::Ready | Role::Working | Role::Review),
        }
    }
}
fn perform_action(
    db: &Mutex<Connection>,
    config: &Config,
    item: &str,
    action: Action,
    expected_status: &str,
    expected_revision: &str,
    transition: Option<&str>,
    api: &mut impl TaskApi,
) -> Result<Value, String> {
    let scope = create_scope(config);
    let rules = read_rules(&*lock(db)?, &scope)?;
    if rules.revision(&scope) != expected_revision {
        return Err("jira_workflow_conflict".into());
    }
    let mut details = perform_task(db, config, item, TaskAction::Details, api)?;
    let role = rules
        .role(&details.status)
        .ok_or("jira_workflow_unmapped")?;
    let mut outcome = "confirmed";
    if role != action.target() {
        if details.status != expected_status {
            return Err("jira_task_conflict".into());
        }
        if !action.accepts(role) {
            return Err("jira_workflow_action_unavailable".into());
        }
        let choices: Vec<_> = details
            .transitions
            .iter()
            .filter(|t| rules.role(&t.status) == Some(action.target()))
            .cloned()
            .collect();
        let selected = if let Some(id) = transition {
            Some(
                choices
                    .iter()
                    .find(|t| t.id == id)
                    .ok_or("jira_transition_invalid")?
                    .clone(),
            )
        } else {
            match choices.len() {
                0 => return Err("jira_workflow_action_unavailable".into()),
                1 => Some(choices[0].clone()),
                _ => None,
            }
        };
        if let Some(selected) = selected {
            let changed = details.changed;
            details = perform_task(
                db,
                config,
                item,
                TaskAction::WorkflowTransition {
                    id: selected.id,
                    expected_status: details.status,
                    target_status: selected.status,
                },
                api,
            )?;
            details.changed += changed;
        } else {
            details.transitions = choices;
            outcome = "choose";
        }
    }
    let mut result = serde_json::to_value(details).map_err(storage)?;
    result["workflowOutcome"] = json!(outcome);
    result["workflowScope"] = json!(scope);
    result["workflowRevision"] = json!(rules.revision(&scope));
    Ok(result)
}
#[tauri::command(rename_all = "camelCase")]
pub async fn jira_task_workflow_action(
    app: tauri::AppHandle,
    item_id: String,
    action: Action,
    expected_status: String,
    expected_revision: String,
    transition_id: Option<String>,
) -> Result<Value, String> {
    blocking(app, move |app| {
        let runtime = app.state::<Runtime>();
        let _running = runtime
            .import
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let db = &app.state::<crate::AppState>().0;
        let config = require_config(&*lock(db)?)?;
        let credential = bound_credential(&runtime, &config)?;
        let mut api = HttpTaskApi::new(&config, &credential).map_err(|e| e.code)?;
        perform_action(
            db,
            &config,
            &item_id,
            action,
            &expected_status,
            &expected_revision,
            transition_id.as_deref(),
            &mut api,
        )
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    const AT: &str = "2026-09-28T10:00:00Z";
    fn fixture() -> (Mutex<Connection>, Config) {
        let conn = Connection::open_in_memory().unwrap();
        crate::init_schema(&conn).unwrap();
        save_config(
            &conn,
            "example.atlassian.net",
            "DEMO",
            TokenMode::Classic,
            AT,
        )
        .unwrap();
        let config = read_config(&conn).unwrap();
        store_catalog(
            &conn,
            &create_scope(&config),
            &["Queue", "Doing", "Check", "Archived", "Unused"].map(String::from),
        )
        .unwrap();
        (Mutex::new(conn), config)
    }
    fn mappings() -> Vec<Mapping> {
        [
            ("Queue", Role::Ready),
            ("Doing", Role::Working),
            ("Check", Role::Review),
            ("Archived", Role::Completed),
            ("Unused", Role::Hidden),
        ]
        .into_iter()
        .map(|(name, bucket)| Mapping {
            name: name.into(),
            bucket: Some(bucket),
        })
        .collect()
    }
    fn save(
        db: &Mutex<Connection>,
        config: &Config,
        process: Option<&str>,
        existing: bool,
    ) -> String {
        let mut conn = lock(db).unwrap();
        let scope = create_scope(config);
        let revision = read_rules(&conn, &scope).unwrap().revision(&scope);
        save_rules(
            &mut conn,
            config,
            &scope,
            &revision,
            mappings(),
            process.map(str::to_owned),
            existing,
        )
        .unwrap()["revision"]
            .as_str()
            .unwrap()
            .to_owned()
    }
    fn issue(config: &Config, id: &str, status: &str) -> Issue {
        Issue {
            id: id.into(),
            project: Some(config.project.clone()),
            title: "Fictional task".into(),
            status: status.into(),
        }
    }
    fn imported(db: &Mutex<Connection>, config: &Config, issue: &Issue) -> String {
        let mut conn = lock(db).unwrap();
        let tx = conn.transaction().unwrap();
        apply_confirmed(&tx, config, std::slice::from_ref(issue), AT).unwrap();
        tx.commit().unwrap();
        item_id(&config.site, &issue.id)
    }
    fn tags(db: &Mutex<Connection>, id: &str) -> String {
        lock(db)
            .unwrap()
            .query_row("SELECT tags FROM items WHERE id=?1", [id], |r| r.get(0))
            .unwrap()
    }
    struct Api {
        current: Issue,
        choices: Vec<Transition>,
        posts: usize,
        offline: bool,
        unknown: bool,
        readback_fails: bool,
        transition_reads: usize,
        changed_target: bool,
    }
    impl Api {
        fn new(config: &Config) -> Self {
            Self {
                current: issue(config, "10001", "Queue"),
                choices: vec![Transition {
                    id: "1".into(),
                    name: "Begin".into(),
                    status: "Doing".into(),
                }],
                posts: 0,
                offline: false,
                unknown: false,
                readback_fails: false,
                transition_reads: 0,
                changed_target: false,
            }
        }
    }
    impl TaskApi for Api {
        fn project_issues(&mut self) -> Result<Fetched, Failure> {
            if self.offline {
                return Err(failure("jira_network_unavailable"));
            }
            Ok(Fetched {
                issues: vec![self.current.clone()],
                truncated: false,
            })
        }
        fn read_issue(&mut self, _: &str) -> Result<Issue, Failure> {
            if self.posts > 0 && self.readback_fails {
                return Err(failure("jira_timeout"));
            }
            Ok(self.current.clone())
        }
        fn transitions(&mut self, _: &str) -> Result<Vec<Transition>, Failure> {
            self.transition_reads += 1;
            if self.changed_target && self.transition_reads > 1 {
                self.choices[0].status = "Check".into();
            }
            Ok(self.choices.clone())
        }
        fn rename(&mut self, _: &str, _: &str) -> Result<(), Failure> {
            panic!("workflow must never rename");
        }
        fn transition(&mut self, _: &str, id: &str) -> Result<(), Failure> {
            self.posts += 1;
            self.current.status = self
                .choices
                .iter()
                .find(|t| t.id == id)
                .unwrap()
                .status
                .clone();
            if self.unknown {
                Err(failure("jira_write_outcome_unknown"))
            } else {
                Ok(())
            }
        }
    }
    #[test]
    fn workflow_catalog_projects_only_names_from_every_issue_type() {
        let raw = br#"[{"name":"type","description":"PRIVATE","statuses":[{"id":"1","name":"Queue","description":"PRIVATE","statusCategory":{"name":"Done"}}]},{"statuses":[{"id":"2","name":"Queue"},{"id":"3","name":"Unused"}]}]"#;
        assert_eq!(parse_catalog(raw).unwrap(), ["Queue", "Unused"]);
        assert!(parse_catalog(br#"[{"statuses":[{"id":"1","name":""}]}]"#).is_err());
        let (db, config) = fixture();
        let conn = lock(&db).unwrap();
        let result = snapshot(&conn, &config).unwrap();
        assert!(result["statuses"]
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r["bucket"].is_null()));
        assert!(result["defaultProcessId"].is_null());
        assert!(!result.to_string().contains("PRIVATE"));
    }
    #[test]
    fn workflow_save_is_local_scoped_and_rejects_stale_or_unknown_rules() {
        let (db, config) = fixture();
        let scope = create_scope(&config);
        let old = read_rules(&lock(&db).unwrap(), &scope)
            .unwrap()
            .revision(&scope);
        let revision = save(&db, &config, None, false);
        assert_ne!(old, revision);
        let mut conn = lock(&db).unwrap();
        assert_eq!(
            save_rules(&mut conn, &config, &scope, &old, mappings(), None, false).unwrap_err(),
            "jira_workflow_conflict"
        );
        let mut other = config.clone();
        other.project = "OTHER".into();
        assert_ne!(
            read_rules(&conn, &create_scope(&other))
                .unwrap()
                .revision(&create_scope(&other)),
            old
        );
        assert_eq!(
            save_rules(
                &mut conn,
                &config,
                &create_scope(&other),
                &revision,
                mappings(),
                None,
                false
            )
            .unwrap_err(),
            "jira_workflow_conflict"
        );
        assert_eq!(
            save_rules(
                &mut conn,
                &config,
                &scope,
                &revision,
                vec![Mapping {
                    name: "Invented".into(),
                    bucket: Some(Role::Completed)
                }],
                None,
                false
            )
            .unwrap_err(),
            "jira_workflow_mapping_invalid"
        );
        assert_eq!(
            read_rules(&conn, &scope).unwrap().revision(&scope),
            revision
        );
    }
    #[test]
    fn workflow_default_process_is_new_only_until_explicit_bulk_apply() {
        let (db, config) = fixture();
        let old = imported(&db, &config, &issue(&config, "1", "Queue"));
        save(&db, &config, Some(attributes::DEFAULT_PROCESS), false);
        let new = imported(&db, &config, &issue(&config, "2", "Queue"));
        assert_eq!(attributes::process(&tags(&db, &old)), None);
        assert_eq!(
            attributes::process(&tags(&db, &new)),
            Some(attributes::DEFAULT_PROCESS)
        );
        let foreign = imported(&db, &config, &issue(&config, "3", "Queue"));
        {
            let conn = lock(&db).unwrap();
            conn.execute(
                "UPDATE items SET tags=?1 WHERE id=?2",
                params![
                    attributes::edit_stage(
                        &tags_without_lock(&conn, &foreign),
                        attributes::StageEdit {
                            process: Some(""),
                            ..Default::default()
                        },
                        AT,
                        AT
                    ),
                    foreign
                ],
            )
            .unwrap();
            conn.execute(
                "UPDATE jira_workflow_members SET scope_hash='other' WHERE item_id=?1",
                [&foreign],
            )
            .unwrap();
            let cleared = attributes::edit_stage(
                &tags_without_lock(&conn, &new),
                attributes::StageEdit {
                    process: Some(""),
                    ..Default::default()
                },
                AT,
                AT,
            );
            conn.execute(
                "UPDATE items SET tags=?1 WHERE id=?2",
                params![cleared, new],
            )
            .unwrap();
        }
        imported(&db, &config, &issue(&config, "2", "Queue"));
        assert_eq!(
            attributes::process(&tags(&db, &new)),
            None,
            "refresh preserves explicit opt-out"
        );
        save(&db, &config, Some(attributes::DEFAULT_PROCESS), true);
        assert_eq!(
            attributes::process(&tags(&db, &old)),
            Some(attributes::DEFAULT_PROCESS)
        );
        assert_eq!(attributes::process(&tags(&db, &foreign)), None);
    }
    fn tags_without_lock(conn: &Connection, id: &str) -> String {
        conn.query_row("SELECT tags FROM items WHERE id=?1", [id], |r| r.get(0))
            .unwrap()
    }
    #[test]
    fn workflow_create_fields_can_explicitly_clear_the_project_default() {
        let (db, config) = fixture();
        save(&db, &config, Some(attributes::DEFAULT_PROCESS), false);
        let current = issue(&config, "4", "Queue");
        let id = item_id(&config.site, &current.id);
        let mut conn = lock(&db).unwrap();
        let tx = conn.transaction().unwrap();
        apply_confirmed(&tx, &config, &[current], AT).unwrap();
        assert_eq!(
            attributes::process(&tags_without_lock(&tx, &id)),
            Some(attributes::DEFAULT_PROCESS)
        );
        crate::calendar_compat::save_task_in_transaction(
            &tx,
            Some(id.clone()),
            "Fictional task".into(),
            None,
            None,
            None,
            None,
            None,
            crate::calendar_compat::TaskFields {
                process: Some("".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(attributes::process(&tags_without_lock(&tx, &id)), None);
        tx.commit().unwrap();
    }
    #[test]
    fn workflow_classification_preserves_local_completion_and_timers() {
        let (db, config) = fixture();
        save(&db, &config, None, false);
        let id = imported(&db, &config, &issue(&config, "1", "Archived"));
        let conn = lock(&db).unwrap();
        let completed: bool = conn
            .query_row("SELECT completed FROM items WHERE id=?1", [&id], |r| {
                r.get(0)
            })
            .unwrap();
        assert!(!completed);
        let mut rows = vec![
            json!({"source_id":id,"jira_status":"Archived","is_active":true}),
            json!({"source_id":"jira:unlinked","jira_status":"Archived"}),
        ];
        decorate_records(&conn, &mut rows).unwrap();
        assert_eq!(rows[0]["jira_workflow_role"], "completed");
        assert_eq!(rows[0]["is_active"], true);
        assert_eq!(rows[1]["jira_workflow_role"], "unassigned");
        assert!(rows[1]["jira_workflow_scope"].is_null());
        rows[0]["jira_status"] = json!("Renamed");
        decorate_records(&conn, &mut rows).unwrap();
        assert_eq!(rows[0]["jira_workflow_role"], "unassigned");
    }
    #[test]
    fn workflow_membership_only_import_notifies_once_without_double_counting() {
        let (db, config) = fixture();
        let conn = lock(&db).unwrap();
        let current = issue(&config, "8", "Queue");
        assert_eq!(
            apply(&conn, &config.site, std::slice::from_ref(&current), AT).unwrap(),
            1
        );
        assert_eq!(
            apply_confirmed(&conn, &config, std::slice::from_ref(&current), AT).unwrap(),
            1
        );
        assert_eq!(apply_confirmed(&conn, &config, &[current], AT).unwrap(), 0);
        assert_eq!(
            apply_confirmed(&conn, &config, &[issue(&config, "9", "Queue")], AT).unwrap(),
            1
        );
    }
    #[test]
    fn workflow_ambiguous_transition_needs_choice_and_rechecks_it() {
        let (db, config) = fixture();
        let revision = save(&db, &config, None, false);
        let mut api = Api::new(&config);
        api.choices.push(Transition {
            id: "2".into(),
            name: "Another way".into(),
            status: "Doing".into(),
        });
        let id = imported(&db, &config, &api.current);
        let choice = perform_action(
            &db,
            &config,
            &id,
            Action::Start,
            "Queue",
            &revision,
            None,
            &mut api,
        )
        .unwrap();
        assert_eq!(choice["workflowOutcome"], "choose");
        assert_eq!(choice["transitions"].as_array().unwrap().len(), 2);
        assert_eq!(api.posts, 0);
        assert_eq!(
            perform_action(
                &db,
                &config,
                &id,
                Action::Start,
                "Queue",
                &revision,
                Some("forged"),
                &mut api
            )
            .unwrap_err(),
            "jira_transition_invalid"
        );
        let confirmed = perform_action(
            &db,
            &config,
            &id,
            Action::Start,
            "Queue",
            &revision,
            Some("2"),
            &mut api,
        )
        .unwrap();
        assert_eq!(confirmed["workflowOutcome"], "confirmed");
        assert_eq!(confirmed["status"], "Doing");
        assert_eq!(api.posts, 1);
    }
    #[test]
    fn workflow_unknown_write_is_read_before_explicit_retry_without_second_post() {
        let (db, config) = fixture();
        let revision = save(&db, &config, None, false);
        let mut api = Api::new(&config);
        api.unknown = true;
        let id = imported(&db, &config, &api.current);
        assert_eq!(
            perform_action(
                &db,
                &config,
                &id,
                Action::Start,
                "Queue",
                &revision,
                None,
                &mut api
            )
            .unwrap_err(),
            "jira_write_outcome_unknown"
        );
        assert_eq!(api.posts, 1);
        let next = perform_action(
            &db,
            &config,
            &id,
            Action::Start,
            "Queue",
            &revision,
            None,
            &mut api,
        )
        .unwrap();
        assert_eq!(next["workflowOutcome"], "confirmed");
        assert_eq!(api.posts, 1);
    }
    #[test]
    fn workflow_rejects_a_transition_whose_destination_changed_before_post() {
        let (db, config) = fixture();
        let revision = save(&db, &config, None, false);
        let mut api = Api::new(&config);
        api.changed_target = true;
        let id = imported(&db, &config, &api.current);
        assert_eq!(
            perform_action(
                &db,
                &config,
                &id,
                Action::Start,
                "Queue",
                &revision,
                None,
                &mut api
            )
            .unwrap_err(),
            "jira_task_conflict"
        );
        assert_eq!(api.posts, 0);
    }
    #[test]
    fn workflow_readback_failure_and_offline_never_confirm_local_action() {
        let (db, config) = fixture();
        let revision = save(&db, &config, None, false);
        let mut api = Api::new(&config);
        api.offline = true;
        let id = imported(&db, &config, &api.current);
        assert_eq!(
            perform_action(
                &db,
                &config,
                &id,
                Action::Start,
                "Queue",
                &revision,
                None,
                &mut api
            )
            .unwrap_err(),
            "jira_network_unavailable"
        );
        assert_eq!(api.posts, 0);
        api.offline = false;
        api.readback_fails = true;
        assert_eq!(
            perform_action(
                &db,
                &config,
                &id,
                Action::Start,
                "Queue",
                &revision,
                None,
                &mut api
            )
            .unwrap_err(),
            "jira_write_outcome_unknown"
        );
        assert_eq!(
            attributes::jira_status(&tags(&db, &id)).as_deref(),
            Some("Queue")
        );
        assert_eq!(api.posts, 1);
    }
    #[test]
    fn workflow_actions_reject_old_rules_status_unknown_and_hidden_sources() {
        let (db, config) = fixture();
        let revision = save(&db, &config, None, false);
        let mut api = Api::new(&config);
        let id = imported(&db, &config, &api.current);
        assert_eq!(
            perform_action(
                &db,
                &config,
                &id,
                Action::Start,
                "Queue",
                "old",
                None,
                &mut api
            )
            .unwrap_err(),
            "jira_workflow_conflict"
        );
        assert_eq!(
            perform_action(
                &db,
                &config,
                &id,
                Action::Start,
                "Other",
                &revision,
                None,
                &mut api
            )
            .unwrap_err(),
            "jira_task_conflict"
        );
        api.current.status = "Unused".into();
        assert_eq!(
            perform_action(
                &db,
                &config,
                &id,
                Action::Start,
                "Unused",
                &revision,
                None,
                &mut api
            )
            .unwrap_err(),
            "jira_workflow_action_unavailable"
        );
        api.current.status = "Unknown".into();
        assert_eq!(
            perform_action(
                &db,
                &config,
                &id,
                Action::Finish,
                "Unknown",
                &revision,
                None,
                &mut api
            )
            .unwrap_err(),
            "jira_workflow_unmapped"
        );
        assert_eq!(api.posts, 0);
    }
}

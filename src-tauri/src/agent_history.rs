//! Durable AI history. The v1 ui_state documents are bounded compatibility views,
//! never retention limits or the authority used to acknowledge a request.
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use uuid::Uuid;

const EXCHANGE: &str = "calendar_task_run_exchange_v1";
const OPERATIONS: &str = "calendar_agent_operations_v1";
const TIMES: &str = "calendar_agent_report_times_v1";
const WINDOW: usize = 500;
fn sql<T>(v: rusqlite::Result<T>) -> Result<T, String> {
    v.map_err(|_| "agent_history_storage".into())
}
fn parse(s: &str) -> Result<Value, String> {
    serde_json::from_str(s).map_err(|_| "agent_history_invalid".into())
}
fn legacy(c: &Connection, key: &str) -> Result<Option<Value>, String> {
    let raw: Option<String> = sql(c
        .query_row("SELECT value FROM ui_state WHERE key=?1", [key], |r| {
            r.get(0)
        })
        .optional())?;
    raw.map(|s| {
        if s.len() > 4 * 1024 * 1024 {
            Err("agent_history_invalid".into())
        } else {
            parse(&s)
        }
    })
    .transpose()
}
pub(crate) fn ready(c: &Connection) -> bool {
    c.query_row(
        "SELECT schema_version FROM agent_history_meta WHERE id=1",
        [],
        |r| r.get::<_, i64>(0),
    )
    .ok()
        == Some(2)
}
pub(crate) fn ensure(c: &Connection) -> Result<(), String> {
    if ready(c) {
        return Ok(());
    }
    sql(c.execute_batch("SAVEPOINT agent_history_migration"))?;
    let result = (|| {
        sql(c.execute_batch("CREATE TABLE IF NOT EXISTS agent_history_meta(id INTEGER PRIMARY KEY CHECK(id=1),schema_version INTEGER NOT NULL,namespace TEXT NOT NULL,received_order INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS agent_task_bindings(task_key TEXT PRIMARY KEY,source_id TEXT NOT NULL UNIQUE,body TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS agent_run_history(run_id TEXT PRIMARY KEY,task_key TEXT NOT NULL,received_order INTEGER NOT NULL,body TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS agent_run_history_order ON agent_run_history(received_order DESC);
          CREATE INDEX IF NOT EXISTS agent_run_history_task ON agent_run_history(task_key,received_order DESC);
          CREATE TABLE IF NOT EXISTS agent_report_times(run_id TEXT PRIMARY KEY,received_at TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS agent_operation_receipts(operation_id TEXT PRIMARY KEY,digest TEXT NOT NULL,result TEXT NOT NULL);"))?;
        let existing: Option<i64> = sql(c
            .query_row(
                "SELECT schema_version FROM agent_history_meta WHERE id=1",
                [],
                |r| r.get(0),
            )
            .optional())?;
        if existing.is_some() {
            return Err("unsupported_agent_history_schema".into());
        }
        let state=legacy(c,EXCHANGE)?.unwrap_or_else(||json!({"version":1,"sourceNamespace":Uuid::new_v4().to_string(),"order":0,"bindings":{},"runs":{}}));
        crate::agent_access::validate_exchange(&state)?;
        let operations = legacy(c, OPERATIONS)?.unwrap_or_else(|| json!({}));
        crate::agent_access::validate_operations(&operations)?;
        let times = legacy(c, TIMES)?.unwrap_or_else(|| json!({}));
        if !times.is_object()
            || times.as_object().unwrap().iter().any(|(id, v)| {
                !crate::agent_access::token(id, 8, 100)
                    || v.as_str()
                        .is_none_or(|s| chrono::DateTime::parse_from_rfc3339(s).is_err())
            })
        {
            return Err("invalid_report_times".into());
        }
        sql(c.execute(
            "INSERT INTO agent_history_meta VALUES(1,2,?1,?2)",
            params![
                state["sourceNamespace"].as_str().unwrap(),
                state["order"].as_i64().ok_or("agent_history_order")?
            ],
        ))?;
        merge_rows(c, &state)?;
        for (id, receipt) in operations.as_object().unwrap() {
            insert_receipt(
                c,
                id,
                receipt["digest"].as_str().unwrap(),
                &receipt["result"],
            )?;
        }
        for (id, at) in times.as_object().unwrap() {
            sql(c.execute(
                "INSERT INTO agent_report_times VALUES(?1,?2)",
                params![id, at.as_str().unwrap()],
            ))?;
        }
        refresh_view(c)
    })();
    match result {
        Ok(()) => sql(c.execute_batch("RELEASE agent_history_migration")),
        Err(e) => {
            let _ = c.execute_batch(
                "ROLLBACK TO agent_history_migration; RELEASE agent_history_migration",
            );
            Err(e)
        }
    }
}
fn meta(c: &Connection) -> Result<Value, String> {
    let (ns, order): (String, i64) = sql(c.query_row(
        "SELECT namespace,received_order FROM agent_history_meta WHERE id=1 AND schema_version=2",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    ))?;
    Ok(json!({"version":1,"sourceNamespace":ns,"order":order,"bindings":{},"runs":{}}))
}
pub(crate) fn binding(c: &Connection, id: &str) -> Result<Option<Value>, String> {
    let raw: Option<String> = sql(c
        .query_row(
            "SELECT body FROM agent_task_bindings WHERE source_id=?1",
            [id],
            |r| r.get(0),
        )
        .optional())?;
    raw.map(|s| parse(&s)).transpose()
}
pub(crate) fn run(c: &Connection, id: &str) -> Result<Option<Value>, String> {
    let raw: Option<String> = sql(c
        .query_row(
            "SELECT body FROM agent_run_history WHERE run_id=?1",
            [id],
            |r| r.get(0),
        )
        .optional())?;
    raw.map(|s| parse(&s)).transpose()
}
pub(crate) fn context(c: &Connection, task: &str, run_id: &str) -> Result<Value, String> {
    ensure(c)?;
    let mut state = meta(c)?;
    if let Some(b) = binding(c, task)? {
        state["bindings"][b["taskKey"].as_str().unwrap()] = b.clone();
    }
    if let Some(r) = run(c, run_id)? {
        let key = r["taskKey"].as_str().ok_or("agent_history_invalid")?;
        let raw: String = sql(c.query_row(
            "SELECT body FROM agent_task_bindings WHERE task_key=?1",
            [key],
            |row| row.get(0),
        ))?;
        state["bindings"][key] = parse(&raw)?;
        state["runs"][run_id] = r.clone();
    }
    crate::agent_access::validate_exchange(&state)?;
    Ok(state)
}
pub(crate) fn load(c: &Connection) -> Result<Value, String> {
    ensure(c)?;
    let mut state = meta(c)?;
    for (table, key, id) in [
        ("agent_task_bindings", "bindings", "task_key"),
        ("agent_run_history", "runs", "run_id"),
    ] {
        let mut q = sql(c.prepare(&format!("SELECT {id},body FROM {table}")))?;
        for row in sql(q.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))))? {
            let (id, raw) = sql(row)?;
            state[key][&id] = parse(&raw)?;
        }
    }
    crate::agent_access::validate_exchange(&state)?;
    Ok(state)
}
fn merge_rows(c: &Connection, state: &Value) -> Result<(), String> {
    for (key, b) in state["bindings"]
        .as_object()
        .ok_or("agent_history_invalid")?
    {
        sql(c.execute("INSERT INTO agent_task_bindings(task_key,source_id,body) VALUES(?1,?2,?3) ON CONFLICT(task_key) DO UPDATE SET body=excluded.body",params![key,b["sourceId"].as_str().ok_or("agent_history_invalid")?,b.to_string()]))?;
    }
    for (id, r) in state["runs"].as_object().ok_or("agent_history_invalid")? {
        if let Some(old) = run(c, id)? {
            let old_order = old["receivedOrder"]
                .as_u64()
                .ok_or("agent_history_invalid")?;
            let new_order = r["receivedOrder"].as_u64().ok_or("agent_history_invalid")?;
            if new_order < old_order {
                continue;
            }
            if new_order == old_order {
                if old != *r {
                    return Err("run_sequence_or_identity_conflict".into());
                }
                continue;
            }
            if ["taskKey", "agent", "model", "provider"]
                .iter()
                .any(|key| old[*key] != r[*key])
            {
                return Err("run_sequence_or_identity_conflict".into());
            }
            if !old["report"].is_null() {
                if r["report"].is_null() {
                    return Err("run_sequence_or_identity_conflict".into());
                }
                let mut check = state.clone();
                check["runs"] = json!({});
                check["runs"][id] = old;
                crate::agent_access::record_report(
                    &mut check,
                    &state["bindings"][r["taskKey"].as_str().unwrap()],
                    r["report"].clone(),
                )?;
            }
        }
        sql(c.execute("INSERT INTO agent_run_history VALUES(?1,?2,?3,?4) ON CONFLICT(run_id) DO UPDATE SET received_order=excluded.received_order,body=excluded.body WHERE excluded.received_order>agent_run_history.received_order",params![id,r["taskKey"].as_str().ok_or("agent_history_invalid")?,r["receivedOrder"].as_i64().ok_or("agent_history_order")?,r.to_string()]))?;
    }
    Ok(())
}
pub(crate) fn save(c: &Connection, state: &Value) -> Result<(), String> {
    crate::agent_access::validate_exchange(state)?;
    sql(c.execute_batch("SAVEPOINT agent_history_save"))?;
    let result = (|| {
        if !ready(c) && legacy(c, EXCHANGE)?.is_none() {
            raw_write(c, EXCHANGE, state)?;
        }
        ensure(c)?;
        if state["sourceNamespace"] != meta(c)?["sourceNamespace"] {
            return Err("task_binding_mismatch".into());
        }
        merge_rows(c, state)?;
        sql(c.execute(
            "UPDATE agent_history_meta SET received_order=max(received_order,?1) WHERE id=1",
            [state["order"].as_i64().ok_or("agent_history_order")?],
        ))?;
        refresh_view(c)
    })();
    match result {
        Ok(()) => sql(c.execute_batch("RELEASE agent_history_save")),
        Err(e) => {
            let _ = c.execute_batch("ROLLBACK TO agent_history_save; RELEASE agent_history_save");
            Err(e)
        }
    }
}
pub(crate) fn receipt(c: &Connection, id: &str) -> Result<Option<Value>, String> {
    ensure(c)?;
    let row: Option<(String, String)> = sql(c
        .query_row(
            "SELECT digest,result FROM agent_operation_receipts WHERE operation_id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional())?;
    row.map(|(d, r)| Ok(json!({"digest":d,"result":parse(&r)?})))
        .transpose()
}
pub(crate) fn insert_receipt(
    c: &Connection,
    id: &str,
    digest: &str,
    result: &Value,
) -> Result<(), String> {
    sql(c.execute(
        "INSERT INTO agent_operation_receipts VALUES(?1,?2,?3)",
        params![id, digest, result.to_string()],
    ))?;
    Ok(())
}
pub(crate) fn receipts(c: &Connection) -> Result<Value, String> {
    let mut value = json!({});
    let mut q = sql(c.prepare("SELECT operation_id,digest,result FROM agent_operation_receipts"))?;
    for row in sql(q.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
        ))
    }))? {
        let (id, d, r) = sql(row)?;
        value[&id] = json!({"digest":d,"result":parse(&r)?});
    }
    Ok(value)
}
pub(crate) fn touch(c: &Connection, id: &str) -> Result<(), String> {
    ensure(c)?;
    sql(c.execute("INSERT INTO agent_report_times VALUES(?1,?2) ON CONFLICT(run_id) DO UPDATE SET received_at=excluded.received_at",params![id,chrono::Utc::now().to_rfc3339()]))?;
    Ok(())
}
pub(crate) fn times(c: &Connection) -> Result<Value, String> {
    let mut value = json!({});
    let mut q = sql(c.prepare("SELECT run_id,received_at FROM agent_report_times"))?;
    for row in sql(q.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))))? {
        let (id, at) = sql(row)?;
        value[&id] = json!(at);
    }
    Ok(value)
}
fn raw_write(c: &Connection, key: &str, value: &Value) -> Result<(), String> {
    sql(c.execute("INSERT INTO ui_state(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",params![key,value.to_string(),chrono::Utc::now().to_rfc3339()]))?;
    Ok(())
}
fn refresh_view(c: &Connection) -> Result<(), String> {
    let mut state = meta(c)?;
    let mut ordered = Vec::new();
    let mut q = sql(c.prepare(
        "SELECT run_id,body FROM agent_run_history ORDER BY received_order DESC,run_id LIMIT 500",
    ))?;
    for row in sql(q.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))))? {
        let (id, raw) = sql(row)?;
        ordered.push(id.clone());
        state["runs"][&id] = parse(&raw)?;
    }
    drop(q);
    loop {
        state["bindings"] = json!({});
        let keys = state["runs"]
            .as_object()
            .unwrap()
            .values()
            .map(|r| {
                r["taskKey"]
                    .as_str()
                    .map(str::to_owned)
                    .ok_or("agent_history_invalid")
            })
            .collect::<Result<Vec<_>, _>>()?;
        for key in keys {
            let raw: String = sql(c.query_row(
                "SELECT body FROM agent_task_bindings WHERE task_key=?1",
                [&key],
                |row| row.get(0),
            ))?;
            state["bindings"][&key] = parse(&raw)?;
        }
        let mut q = sql(c.prepare(
            "SELECT task_key,body FROM agent_task_bindings ORDER BY rowid DESC LIMIT 500",
        ))?;
        for row in sql(q.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))))? {
            if state["bindings"].as_object().unwrap().len() >= WINDOW {
                break;
            }
            let (key, raw) = sql(row)?;
            state["bindings"][&key] = parse(&raw)?;
        }
        if state.to_string().len() <= 4 * 1024 * 1024 {
            break;
        }
        let id = ordered.pop().ok_or("agent_history_view_capacity")?;
        state["runs"].as_object_mut().unwrap().remove(&id);
    }
    let mut times = json!({});
    for id in state["runs"].as_object().unwrap().keys() {
        let at: Option<String> = sql(c
            .query_row(
                "SELECT received_at FROM agent_report_times WHERE run_id=?1",
                [id],
                |r| r.get(0),
            )
            .optional())?;
        if let Some(at) = at {
            times[id] = json!(at);
        }
    }
    raw_write(c, EXCHANGE, &state)?;
    raw_write(c, TIMES, &times)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        crate::init_schema(&c).unwrap();
        c
    }
    fn state() -> Value {
        json!({"version":1,"sourceNamespace":"10000000-0000-4000-8000-000000000001","order":0,"bindings":{},"runs":{}})
    }
    fn add(s: &mut Value, n: usize) {
        let b = crate::agent_access::binding(s, &format!("synthetic-task-{n:04}"));
        let key = b["taskKey"].as_str().unwrap().to_owned();
        s["bindings"][&key] = b.clone();
        crate::agent_access::record_report(s,&b,json!({"runId":format!("synthetic-run-{n:04}"),"sequence":1,"taskKey":null,"agent":"codex","model":null,"provider":null,"stage":null,"status":"running","skillIds":[],"mcpCalls":null,"inputTokens":null,"outputTokens":null})).unwrap();
    }
    #[test]
    fn legacy_migration_preserves_namespace_receipts_runs_and_times() {
        let c = db();
        let mut s = state();
        for n in 0..500 {
            add(&mut s, n)
        }
        raw_write(&c, EXCHANGE, &s).unwrap();
        let mut ops = json!({});
        for n in 0..500 {
            ops[format!("legacy-operation-{n:04}")] =
                json!({"digest":"a".repeat(64),"result":{"synthetic":n}})
        }
        raw_write(&c, OPERATIONS, &ops).unwrap();
        raw_write(
            &c,
            TIMES,
            &json!({"synthetic-run-0000":"2026-10-04T12:00:00Z"}),
        )
        .unwrap();
        ensure(&c).unwrap();
        assert_eq!(load(&c).unwrap(), s);
        assert_eq!(receipts(&c).unwrap(), ops);
        add(&mut s, 500);
        save(&c, &s).unwrap();
        insert_receipt(
            &c,
            "operation-after-500",
            &"b".repeat(64),
            &json!({"synthetic":501}),
        )
        .unwrap();
        assert_eq!(
            load(&c).unwrap()["bindings"].as_object().unwrap().len(),
            501
        );
        assert_eq!(load(&c).unwrap()["runs"].as_object().unwrap().len(), 501);
        assert_eq!(receipts(&c).unwrap().as_object().unwrap().len(), 501);
        assert_eq!(
            receipt(&c, "legacy-operation-0000").unwrap().unwrap(),
            ops["legacy-operation-0000"]
        );
        assert_eq!(
            times(&c).unwrap()["synthetic-run-0000"],
            "2026-10-04T12:00:00Z"
        );
        let view = legacy(&c, EXCHANGE).unwrap().unwrap();
        assert_eq!(view["sourceNamespace"], s["sourceNamespace"]);
        assert_eq!(view["runs"].as_object().unwrap().len(), 500);
        assert_eq!(view["bindings"].as_object().unwrap().len(), 500);
        let old = context(&c, "synthetic-task-0000", "synthetic-run-0000").unwrap();
        assert_eq!(
            old["runs"]["synthetic-run-0000"],
            s["runs"]["synthetic-run-0000"]
        );
    }
    #[test]
    fn invalid_legacy_data_rolls_back_migration_and_first_write() {
        for (key, bad) in [
            (EXCHANGE, json!({"invalid":true})),
            (OPERATIONS, json!({"invalid-op":{}})),
            (TIMES, json!({"synthetic-run-0000":"invalid-date"})),
        ] {
            let c = db();
            raw_write(&c, key, &bad).unwrap();
            assert!(ensure(&c).is_err());
            assert!(!ready(&c));
            assert_eq!(legacy(&c, key).unwrap().unwrap(), bad);
            assert_eq!(
                c.query_row(
                    "SELECT count(*) FROM sqlite_master WHERE name LIKE 'agent_%'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
                0
            );
        }
        let c = db();
        raw_write(&c, OPERATIONS, &json!({"invalid-op":{}})).unwrap();
        assert!(save(&c, &state()).is_err());
        assert!(legacy(&c, EXCHANGE).unwrap().is_none());
        assert!(!ready(&c));
    }
    #[test]
    fn manual_first_namespace_and_partial_import_preserve_omitted_history() {
        let c = db();
        let mut s = state();
        add(&mut s, 0);
        save(&c, &s).unwrap();
        let mut partial = state();
        partial["order"] = s["order"].clone();
        add(&mut partial, 1);
        save(&c, &partial).unwrap();
        let all = load(&c).unwrap();
        assert_eq!(all["sourceNamespace"], s["sourceNamespace"]);
        assert_eq!(all["runs"].as_object().unwrap().len(), 2);
        let mut wrong = state();
        wrong["sourceNamespace"] = json!(Uuid::new_v4().to_string());
        assert!(save(&c, &wrong).is_err());
        assert_eq!(load(&c).unwrap(), all);
    }
    #[test]
    fn imported_run_cannot_change_identity_or_regress_sequence_and_counters() {
        let c = db();
        let mut s = state();
        add(&mut s, 0);
        save(&c, &s).unwrap();
        let mut conflicting = s.clone();
        conflicting["runs"]["synthetic-run-0000"]["report"]["stage"] = json!("changed");
        assert!(save(&c, &conflicting).is_err());
        let key = s["runs"]["synthetic-run-0000"]["taskKey"]
            .as_str()
            .unwrap()
            .to_owned();
        let b = s["bindings"][&key].clone();
        let mut r = s["runs"]["synthetic-run-0000"]["report"].clone();
        r["sequence"] = json!(2);
        r["inputTokens"] = json!(5);
        crate::agent_access::record_report(&mut s, &b, r).unwrap();
        save(&c, &s).unwrap();
        conflicting = s.clone();
        conflicting["order"] = json!(3);
        conflicting["runs"]["synthetic-run-0000"]["receivedOrder"] = json!(3);
        conflicting["runs"]["synthetic-run-0000"]["report"]["sequence"] = json!(3);
        conflicting["runs"]["synthetic-run-0000"]["report"]["inputTokens"] = json!(4);
        assert_eq!(save(&c, &conflicting).unwrap_err(), "usage_decreased");
        assert_eq!(load(&c).unwrap(), s);
    }
    #[test]
    fn stale_frontend_compare_and_swap_cannot_overwrite_native_history() {
        let mut c = db();
        let mut s = state();
        add(&mut s, 0);
        save(&c, &s).unwrap();
        let old = c
            .query_row("SELECT value FROM ui_state WHERE key=?1", [EXCHANGE], |r| {
                r.get::<_, String>(0)
            })
            .unwrap();
        add(&mut s, 1);
        save(&c, &s).unwrap();
        let tx = c.transaction().unwrap();
        assert_eq!(
            crate::mvp_sync_db::set_ui_in_transaction(&tx, EXCHANGE, &old, Some(&old)).unwrap_err(),
            "mvp_sync_stale_ui_state"
        );
        drop(tx);
        assert_eq!(load(&c).unwrap(), s);
    }
}

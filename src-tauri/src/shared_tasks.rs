//! Opt-in projection/commands over native items, exchange and immutable review records.
//! No second task authority, dispatcher, timer inference or secret-bearing task metadata.
use crate::{agent_access as access, native_result_review as review, AppState};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::State;
use uuid::Uuid;

const MAX: i64 = 9_007_199_254_740_991;
const EXCHANGE: &str = "calendar_task_run_exchange_v1";
#[derive(Debug)]
struct Error(u16, &'static str);
type Result<T> = std::result::Result<T, Error>;
fn sql<T>(v: rusqlite::Result<T>) -> Result<T> {
    v.map_err(|_| Error(500, "shared_storage_failure"))
}
fn exact(v: &Value, fields: &[&str]) -> Result<()> {
    if v.as_object()
        .is_none_or(|m| m.len() != fields.len() || fields.iter().any(|f| !m.contains_key(*f)))
    {
        return Err(Error(400, "unsupported_shared_fields"));
    }
    Ok(())
}
fn text(v: &Value, max: usize, empty: bool) -> Result<String> {
    let s = v.as_str().ok_or(Error(400, "invalid_shared_text"))?;
    if s.len() > max
        || (!empty && s.trim().is_empty())
        || s.chars().any(|c| c.is_control() && c != '\n' && c != '\t')
    {
        return Err(Error(400, "invalid_shared_text"));
    }
    Ok(s.into())
}
fn revision(v: &Value) -> Result<i64> {
    v.as_i64()
        .filter(|n| *n > 0 && *n < MAX)
        .ok_or(Error(400, "invalid_shared_revision"))
}
fn initialize(c: &mut Connection) -> Result<()> {
    review::initialize(c).map_err(|_| Error(409, "unsupported_review_schema"))?;
    sql(c.execute_batch("CREATE TABLE IF NOT EXISTS shared_task_operations(operation_id TEXT PRIMARY KEY,task_id TEXT NOT NULL,digest TEXT NOT NULL,receipt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS shared_task_comments(task_id TEXT NOT NULL,operation_id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS shared_task_tombstones(task_id TEXT PRIMARY KEY,binding TEXT NOT NULL,version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS shared_task_result_runs(task_id TEXT NOT NULL,result_version INTEGER NOT NULL,run_id TEXT NOT NULL,PRIMARY KEY(task_id,result_version),UNIQUE(task_id,run_id));
      CREATE TRIGGER IF NOT EXISTS shared_result_requires_review BEFORE UPDATE OF completed,status ON items
      WHEN (NEW.completed=1 OR NEW.status='done') AND EXISTS(SELECT 1 FROM local_review_state r JOIN shared_task_result_runs s ON s.task_id=r.task_id AND s.result_version=r.result_version WHERE r.task_id=NEW.id AND r.state!='accepted')
      BEGIN SELECT RAISE(ABORT,'shared_result_requires_review'); END;"))?;
    let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
    if access::read(&tx, EXCHANGE)
        .map_err(|_| Error(409, "invalid_shared_binding"))?
        .is_none()
    {
        let state = exchange(&tx)?;
        save_exchange(&tx, &state)?;
    }
    sql(tx.commit())
}
fn native(c: &Connection, id: &str) -> Result<Value> {
    access::personal(c, id).map_err(|_| Error(404, "shared_task_not_found"))
}
fn exchange(c: &Connection) -> Result<Value> {
    access::exchange(c).map_err(|_| Error(409, "invalid_shared_binding"))
}
fn bound(c: &Connection, id: &str) -> Result<(Value, Value)> {
    let task = native(c, id)?;
    let state = exchange(c)?;
    let b = access::binding(&state, id);
    if state["bindings"].get(b["taskKey"].as_str().unwrap()) != Some(&b) {
        return Err(Error(404, "shared_task_not_found"));
    }
    Ok((task, b))
}
fn projection(c: &Connection, id: &str) -> Result<Value> {
    let (mut task, b) = bound(c, id)?;
    let (tags, at): (String, String) = sql(c.query_row(
        "SELECT tags,updated_at FROM items WHERE id=?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    ))?;
    let state = exchange(c)?;
    let times = access::read(c, "calendar_agent_report_times_v1")
        .map_err(|_| Error(409, "invalid_report_times"))?
        .unwrap_or(json!({}));
    let reports = state["runs"]
        .as_object()
        .unwrap()
        .values()
        .filter(|r| r["taskKey"] == b["taskKey"])
        .cloned()
        .map(|mut r| {
            r["receivedAt"] = times[r["runId"].as_str().unwrap()].clone();
            r
        })
        .collect::<Vec<_>>();
    let rv: Option<(i64, String, Option<String>)> = sql(c
        .query_row(
            "SELECT result_version,state,intent_id FROM local_review_state WHERE task_id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional())?;
    let rows = |table: &str, column: &str| -> Result<Vec<Value>> {
        let mut stmt = sql(c.prepare(&format!(
            "SELECT {column} FROM {table} WHERE task_id=?1 ORDER BY rowid"
        )))?;
        let raw = sql(stmt.query_map([id], |r| r.get::<_, String>(0)))?;
        sql(raw.collect::<rusqlite::Result<Vec<_>>>())?
            .into_iter()
            .map(|s| serde_json::from_str(&s).map_err(|_| Error(500, "invalid_shared_record")))
            .collect()
    };
    let mut results = vec![];
    let mut q=sql(c.prepare("SELECT result_version,content,published_task_version FROM local_review_results WHERE task_id=?1 ORDER BY result_version"))?;
    let raw=sql(q.query_map([id],|r|Ok(json!({"version":r.get::<_,i64>(0)?,"content":r.get::<_,String>(1)?,"publishedTaskVersion":r.get::<_,i64>(2)?}))))?;
    for r in raw {
        results.push(sql(r)?)
    }
    let mut intents = vec![];
    let mut q=sql(c.prepare("SELECT intent_id,result_version,comment,state,event_id FROM local_review_intents WHERE task_id=?1 ORDER BY rowid"))?;
    for r in sql(q.query_map([id],|r|Ok(json!({"intentId":r.get::<_,String>(0)?,"resultVersion":r.get::<_,i64>(1)?,"comment":r.get::<_,String>(2)?,"state":r.get::<_,String>(3)?,"eventId":r.get::<_,String>(4)?}))))? {intents.push(sql(r)?)}
    let workflow = access::read(c, &format!("calendar_task_workflow_v1:{id}"))
        .map_err(|_| Error(409, "invalid_existing_workflow"))?;
    task["stage"] = json!(crate::task_attributes::stage(&tags));
    task["process"] = json!(crate::task_attributes::effective_process(&tags));
    task["waiting"] = json!(crate::task_attributes::waiting(&tags));
    task["stageHistory"] = json!(crate::task_attributes::stage_log(&tags)
        .into_iter()
        .map(|(stage, at)| json!({"stage":stage,"at":at}))
        .collect::<Vec<_>>());
    task["binding"] = b;
    task["tags"] = json!(tags);
    task["updatedAt"] = json!(at);
    task["reports"] = json!(reports);
    task["workflow"] = workflow.unwrap_or(Value::Null);
    task["results"] = json!(results);
    task["history"] = json!(rows("local_review_audit", "body")?);
    task["comments"] = json!(rows("shared_task_comments", "body")?);
    task["intents"] = json!(intents);
    task["review"] = rv
        .map(|(v, s, i)| json!({"resultVersion":v,"state":s,"intentId":i}))
        .unwrap_or(Value::Null);
    let active:i64=sql(c.query_row("SELECT count(*) FROM timeline_blocks WHERE source_type='note' AND source_id=?1 AND is_active=1",[id],|r|r.get(0)))?;
    task["humanTimerActive"] = json!(active > 0);
    Ok(task)
}
fn save_exchange(c: &Connection, state: &Value) -> Result<()> {
    access::write(c, EXCHANGE, state).map_err(|_| Error(409, "shared_capacity"))
}
fn add_binding(c: &Connection, id: &str) -> Result<()> {
    let mut s = exchange(c)?;
    let b = access::binding(&s, id);
    let key = b["taskKey"].as_str().unwrap().to_owned();
    if s["bindings"].get(&key).is_none() && s["bindings"].as_object().unwrap().len() >= 500 {
        return Err(Error(409, "shared_capacity"));
    }
    s["bindings"][&key] = b;
    save_exchange(c, &s)
}
fn bump(c: &Connection, id: &str, version: i64) -> Result<()> {
    if sql(c.execute(
        "UPDATE items SET version=version+1,updated_at=?1 WHERE id=?2 AND version=?3",
        params![chrono::Utc::now().to_rfc3339(), id, version],
    ))? != 1
    {
        return Err(Error(409, "revision_conflict"));
    }
    Ok(())
}
fn audit(
    c: &Connection,
    id: &str,
    op: &str,
    action: &str,
    version: i64,
    rv: i64,
    comment: Option<String>,
) -> Result<()> {
    let a = review::Audit {
        action: action.into(),
        result_version: rv,
        comment,
        operation_id: op.into(),
        task_revision: version,
        event_id: Uuid::new_v4().to_string(),
    };
    sql(c.execute(
        "INSERT INTO local_review_audit(task_id,operation_id,body) VALUES(?1,?2,?3)",
        params![id, op, serde_json::to_string(&a).unwrap()],
    ))?;
    Ok(())
}

fn perform(c: &mut Connection, op: &str, command: &str, args: Value) -> Result<Value> {
    if !op.is_ascii()
        || !(8..=100).contains(&op.len())
        || op
            .bytes()
            .any(|b| !b.is_ascii_alphanumeric() && b != b'-' && b != b'_')
    {
        return Err(Error(400, "invalid_shared_operation"));
    }
    if ![
        "snapshot",
        "get",
        "operation",
        "create",
        "share",
        "patch",
        "comment",
        "submit_result",
        "review",
        "acknowledge",
        "archive",
    ]
    .contains(&command)
    {
        return Err(Error(400, "unsupported_shared_command"));
    }
    if command == "snapshot" {
        exact(&args, &[])?;
        let tx = sql(c.transaction())?;
        let state = exchange(&tx)?;
        let mut tasks = vec![];
        for b in state["bindings"].as_object().unwrap().values() {
            let id = b["sourceId"].as_str().unwrap();
            // Scope changes/revocation remove the projection, without disclosing former content.
            match projection(&tx, id) {
                Ok(t) => tasks.push(t),
                Err(Error(404, _)) => {}
                Err(e) => return Err(e),
            }
        }
        let mut q =
            sql(tx.prepare("SELECT binding,version FROM shared_task_tombstones ORDER BY task_id"))?;
        let tombstones=sql(q.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?))))?.map(|r|{
            let (b,v)=sql(r)?;Ok(json!({"binding":serde_json::from_str::<Value>(&b).map_err(|_|Error(500,"invalid_shared_record"))?,"version":v}))
        }).collect::<Result<Vec<_>>>()?;
        drop(q);
        let result = json!({"schemaVersion":1,"sourceNamespace":state["sourceNamespace"],"tasks":tasks,"tombstones":tombstones,"asOf":chrono::Utc::now().to_rfc3339(),"complete":true});
        // Never silently return a truncated snapshot that could erase a client projection.
        if result.to_string().len() > 900_000 {
            return Err(Error(409, "shared_snapshot_capacity"));
        }
        sql(tx.commit())?;
        return Ok(result);
    }
    if command == "get" {
        exact(&args, &["taskId"])?;
        return projection(c, &text(&args["taskId"], 80, false)?);
    }
    if command == "operation" {
        exact(&args, &["operationId"])?;
        let key = text(&args["operationId"], 100, false)?;
        let row: Option<(String, String)> = sql(c
            .query_row(
                "SELECT task_id,receipt FROM shared_task_operations WHERE operation_id=?1",
                [key],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional())?;
        return match row {
            None => Ok(json!({"known":false})),
            Some((id, receipt)) => {
                native(c, &id)?;
                Ok(
                    json!({"known":true,"receipt":serde_json::from_str::<Value>(&receipt).map_err(|_|Error(500,"invalid_shared_record"))?}),
                )
            }
        };
    }
    let digest = hex::encode(Sha256::digest(
        json!({"command":command,"arguments":args})
            .to_string()
            .as_bytes(),
    ));
    let tx = sql(c.transaction_with_behavior(TransactionBehavior::Immediate))?;
    let old: Option<(String, String, String)> = sql(tx
        .query_row(
            "SELECT task_id,digest,receipt FROM shared_task_operations WHERE operation_id=?1",
            [op],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional())?;
    if let Some((id, d, receipt)) = old {
        // Archived receipts can replay without resurrecting a task; content scope is rechecked.
        let tags: String =
            sql(tx.query_row("SELECT tags FROM items WHERE id=?1", [&id], |r| r.get(0)))?;
        if !tags.split(',').any(|t| t == "task-sphere:personal")
            || tags.split(',').any(|t| {
                t.starts_with("jira") || t.starts_with("investlink") || t == "task-sphere:work"
            })
        {
            return Err(Error(404, "shared_task_not_found"));
        }
        if d != digest {
            return Err(Error(409, "operation_payload_conflict"));
        }
        return serde_json::from_str(&receipt).map_err(|_| Error(500, "invalid_shared_record"));
    }
    let count: i64 = sql(
        tx.query_row("SELECT count(*) FROM shared_task_operations", [], |r| {
            r.get(0)
        }),
    )?;
    if count >= 5000 {
        return Err(Error(409, "shared_operation_capacity"));
    }
    let id = if command == "create" {
        exact(&args, &["title", "content"])?;
        let title = text(&args["title"], 500, false)?;
        let content = text(&args["content"], 8000, true)?;
        let item = crate::calendar_compat::create_note_in_transaction(
            &tx,
            &title,
            &content,
            "task-sphere:personal,source:shared",
            "task",
            &None,
            None,
        )
        .map_err(|_| Error(400, "invalid_native_task"))?;
        add_binding(&tx, &item.id)?;
        item.id
    } else {
        let id = text(&args["taskId"], 80, false)?;
        let task = if command == "share" {
            native(&tx, &id)?
        } else {
            bound(&tx, &id)?.0
        };
        let v = revision(&args["expectedVersion"])?;
        if task["version"] != v {
            return Err(Error(409, "revision_conflict"));
        }
        let rv: Option<(i64, String, Option<String>)> = sql(tx
            .query_row(
                "SELECT result_version,state,intent_id FROM local_review_state WHERE task_id=?1",
                [&id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional())?;
        match command {
            "share" => {
                exact(&args, &["taskId", "expectedVersion"])?;
                add_binding(&tx, &id)?;
            }
            "patch" => {
                exact(&args, &["taskId", "expectedVersion", "patch"])?;
                let p = args["patch"]
                    .as_object()
                    .filter(|m| {
                        !m.is_empty()
                            && m.keys().all(|k| {
                                ["title", "content", "stage", "process", "waiting", "status"]
                                    .contains(&k.as_str())
                            })
                    })
                    .ok_or(Error(400, "invalid_task_patch"))?;
                let (mut title, mut content): (String, String) = sql(tx.query_row(
                    "SELECT title,notes FROM items WHERE id=?1",
                    [&id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                ))?;
                if let Some(t) = p.get("title") {
                    title = text(t, 500, false)?
                }
                if let Some(t) = p.get("content") {
                    content = text(t, 8000, true)?
                }
                let (tags, since): (String, String) = sql(tx.query_row(
                    "SELECT tags,created_at FROM items WHERE id=?1",
                    [&id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                ))?;
                let stage = p.get("stage").map(|s| text(s, 80, true)).transpose()?;
                let process = p.get("process").map(|s| text(s, 80, true)).transpose()?;
                if let Some(s) = &stage {
                    crate::task_attributes::validate_stage(s)
                        .map_err(|_| Error(400, "invalid_stage"))?
                }
                if let Some(s) = &process {
                    crate::task_attributes::validate_process(s)
                        .map_err(|_| Error(400, "invalid_process"))?
                }
                let waiting = p
                    .get("waiting")
                    .map(|v| v.as_bool().ok_or(Error(400, "invalid_waiting")))
                    .transpose()?;
                let tags = crate::task_attributes::edit_stage(
                    &tags,
                    crate::task_attributes::StageEdit {
                        stage: stage.as_deref(),
                        process: process.as_deref(),
                        waiting,
                    },
                    &chrono::Utc::now().to_rfc3339(),
                    &since,
                );
                sql(tx.execute(
                    "UPDATE items SET title=?1,notes=?2,tags=?3 WHERE id=?4",
                    params![title, content, tags, id],
                ))?;
                if let Some(status) = p.get("status") {
                    if rv.is_some() {
                        return Err(Error(409, "review_controls_status"));
                    }
                    let status = status
                        .as_str()
                        .filter(|s| ["task", "done"].contains(s))
                        .ok_or(Error(400, "invalid_task_status"))?;
                    if status == "done" {
                        let active:i64=sql(tx.query_row("SELECT count(*) FROM timeline_blocks WHERE source_type='note' AND source_id=?1 AND is_active=1",[&id],|r|r.get(0)))?;
                        if active > 0 {
                            return Err(Error(409, "human_timer_active"));
                        }
                    }
                    sql(tx.execute(
                        "UPDATE items SET status=?1,completed=?2 WHERE id=?3",
                        params![status, status == "done", id],
                    ))?;
                }
            }
            "comment" => {
                exact(&args, &["taskId", "expectedVersion", "comment"])?;
                let comment = text(&args["comment"], 8000, false)?;
                sql(tx.execute("INSERT INTO shared_task_comments VALUES(?1,?2,?3)",params![id,op,json!({"operationId":op,"content":comment,"at":chrono::Utc::now().to_rfc3339()}).to_string()]))?;
            }
            "submit_result" => {
                exact(&args, &["taskId", "expectedVersion", "runId", "content"])?;
                let run = text(&args["runId"], 100, false)?;
                let content = text(&args["content"], 8000, false)?;
                let s = exchange(&tx)?;
                let b = access::binding(&s, &id);
                if s["runs"][&run]["taskKey"] != b["taskKey"]
                    || s["runs"][&run]["report"]["status"] != "done"
                {
                    return Err(Error(409, "completed_execution_required"));
                }
                if sql(tx.query_row(
                    "SELECT count(*) FROM shared_task_result_runs WHERE task_id=?1 AND run_id=?2",
                    params![id, run],
                    |r| r.get::<_, i64>(0),
                ))? > 0
                {
                    return Err(Error(409, "result_run_already_published"));
                }
                if task["completed"] == true
                    || rv.as_ref().is_some_and(|(_, s, _)| {
                        !["running", "awaiting_review"].contains(&s.as_str())
                    })
                {
                    return Err(Error(409, "result_not_expected"));
                }
                let n = rv.as_ref().map_or(1, |(n, _, _)| n + 1);
                sql(tx.execute(
                    "INSERT INTO local_review_results VALUES(?1,?2,?3,?4)",
                    params![id, n, content, v + 1],
                ))?;
                sql(tx.execute(
                    "INSERT INTO shared_task_result_runs VALUES(?1,?2,?3)",
                    params![id, n, run],
                ))?;
                if let Some((_, _, Some(intent))) = &rv {
                    sql(tx.execute(
                        "UPDATE local_review_intents SET state='completed' WHERE intent_id=?1",
                        [intent],
                    ))?;
                }
                sql(tx.execute("INSERT OR REPLACE INTO local_review_state VALUES(?1,?2,'awaiting_review',NULL)",params![id,n]))?;
                audit(&tx, &id, op, command, v + 1, n, None)?;
            }
            "review" => {
                let rework = args["decision"] == "rework";
                exact(
                    &args,
                    if rework {
                        &[
                            "taskId",
                            "expectedVersion",
                            "resultVersion",
                            "decision",
                            "comment",
                        ]
                    } else {
                        &["taskId", "expectedVersion", "resultVersion", "decision"]
                    },
                )?;
                if !rework && args["decision"] != "accept" {
                    return Err(Error(400, "invalid_review_decision"));
                }
                let n = revision(&args["resultVersion"])?;
                if rv
                    .as_ref()
                    .is_none_or(|(v, s, _)| *v != n || s != "awaiting_review")
                {
                    return Err(Error(409, "stale_review_result"));
                }
                let comment = if rework {
                    Some(text(&args["comment"], 8000, false)?)
                } else {
                    None
                };
                if !rework {
                    let active:i64=sql(tx.query_row("SELECT count(*) FROM timeline_blocks WHERE source_type='note' AND source_id=?1 AND is_active=1",[&id],|r|r.get(0)))?;
                    if active > 0 {
                        return Err(Error(409, "human_timer_active"));
                    }
                }
                sql(tx.execute(
                    "UPDATE local_review_state SET state=?1,intent_id=?2 WHERE task_id=?3",
                    params![
                        if rework {
                            "awaiting_dispatch"
                        } else {
                            "accepted"
                        },
                        if rework { Some(op) } else { None },
                        id
                    ],
                ))?;
                sql(tx.execute(
                    "UPDATE items SET completed=?1,status=?2 WHERE id=?3",
                    params![!rework, if rework { "task" } else { "done" }, id],
                ))?;
                if rework {
                    sql(tx.execute("INSERT INTO local_review_intents VALUES(?1,?2,?3,?4,?5,'awaiting_dispatch',?6)",params![op,id,n,v+1,comment,Uuid::new_v4().to_string()]))?;
                }
                audit(
                    &tx,
                    &id,
                    op,
                    if rework { "rework" } else { "accept" },
                    v + 1,
                    n,
                    comment,
                )?;
            }
            "acknowledge" => {
                exact(&args, &["taskId", "expectedVersion", "intentId", "report"])?;
                let intent = text(&args["intentId"], 100, false)?;
                let (n, s, i) = rv.ok_or(Error(409, "rework_not_expected"))?;
                if s != "awaiting_dispatch" || i.as_deref() != Some(&intent) {
                    return Err(Error(409, "rework_not_expected"));
                }
                if args["report"]["status"] != "running" || args["report"]["sequence"] != 1 {
                    return Err(Error(400, "execution_acknowledgement_required"));
                }
                let mut state = exchange(&tx)?;
                let b = access::binding(&state, &id);
                let run = args["report"]["runId"]
                    .as_str()
                    .ok_or(Error(400, "invalid_acknowledgement"))?;
                if state["runs"].get(run).is_some() {
                    return Err(Error(409, "new_run_required"));
                }
                access::record_report(&mut state, &b, args["report"].clone())
                    .map_err(|_| Error(400, "invalid_acknowledgement"))?;
                save_exchange(&tx, &state)?;
                access::record_received_at(&tx, run)
                    .map_err(|_| Error(409, "invalid_report_times"))?;
                sql(tx.execute(
                    "UPDATE local_review_intents SET state='acknowledged' WHERE intent_id=?1",
                    [intent],
                ))?;
                sql(tx.execute(
                    "UPDATE local_review_state SET state='running' WHERE task_id=?1",
                    [&id],
                ))?;
                audit(&tx, &id, op, "acknowledge", v + 1, n, None)?;
            }
            "archive" => {
                exact(&args, &["taskId", "expectedVersion"])?;
                if rv
                    .as_ref()
                    .is_some_and(|(_, s, _)| s == "awaiting_dispatch" || s == "running")
                {
                    return Err(Error(409, "active_rework_intent"));
                }
                let b = bound(&tx, &id)?.1;
                sql(tx.execute(
                    "INSERT INTO shared_task_tombstones VALUES(?1,?2,?3)",
                    params![id, b.to_string(), v + 1],
                ))?;
                sql(tx.execute("UPDATE items SET archived=1 WHERE id=?1", [&id]))?;
            }
            _ => return Err(Error(400, "unsupported_shared_command")),
        };
        bump(&tx, &id, v)?;
        id
    };
    let task = if command == "archive" {
        json!({"id":id,"deleted":true,"version":args["expectedVersion"].as_i64().unwrap()+1})
    } else {
        projection(&tx, &id)?
    };
    let receipt = json!({"operationId":op,"task":task,"acknowledged":true});
    sql(tx.execute(
        "INSERT INTO shared_task_operations VALUES(?1,?2,?3,?4)",
        params![op, id, digest, receipt.to_string()],
    ))?;
    sql(tx.commit())?;
    Ok(receipt)
}

pub(crate) fn execute(c: &mut Connection, op: &str, command: &str, args: Value) -> Value {
    let id = args["taskId"].as_str().map(str::to_string);
    let outcome = initialize(c).and_then(|_| perform(c, op, command, args));
    match outcome {
        Ok(v) => v,
        Err(Error(status, code)) => {
            let current = if status == 409 {
                id.and_then(|id| projection(c, &id).ok())
            } else {
                None
            };
            json!({"isError":true,"status":status,"code":code,"error":code,"current":current})
        }
    }
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Command {
    operation_id: String,
    command: String,
    arguments: Value,
}
#[tauri::command]
pub(crate) fn shared_task_command(input: Command, state: State<'_, AppState>) -> Value {
    match state.0.lock() {
        Ok(mut c) => execute(&mut c, &input.operation_id, &input.command, input.arguments),
        Err(_) => json!({"isError":true,"status":503,"code":"shared_database_busy"}),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        crate::init_schema(&c).unwrap();
        c
    }
    #[test]
    fn empty_namespace_is_stable() {
        let mut c = db();
        let a = call(&mut c, "empty-source-001", "snapshot", json!({}));
        let b = call(&mut c, "empty-source-002", "snapshot", json!({}));
        assert_eq!(a["sourceNamespace"], b["sourceNamespace"]);
        assert_eq!(
            a["sourceNamespace"],
            create(&mut c)["task"]["binding"]["sourceNamespace"]
        );
    }
    #[test]
    fn ordinary_completion_cannot_bypass_review() {
        let mut c = db();
        let a = create(&mut c);
        let id = a["task"]["id"].as_str().unwrap();
        observed(&mut c, id, 1, "test-run-guard");
        call(
            &mut c,
            "result-guard-001",
            "submit_result",
            json!({"taskId":id,"expectedVersion":1,"runId":"test-run-guard","content":"Awaiting user"}),
        );
        assert!(c
            .execute(
                "UPDATE items SET completed=1,status='done' WHERE id=?1",
                [id]
            )
            .is_err());
        assert_eq!(projection(&c, id).unwrap()["completed"], false);
    }
    /// Synthetic cross-language acceptance harness. Excluded from normal tests and shipping binary.
    #[test]
    #[ignore]
    fn stdio_fixture() {
        use std::io::{BufRead, Write};
        let path = std::env::var("CICADA_SYNTHETIC_TEST_DB")
            .expect("explicit synthetic database required");
        let mut c = Connection::open(path).unwrap();
        crate::init_schema(&c).unwrap();
        for line in std::io::stdin().lock().lines() {
            let input: Value = serde_json::from_str(&line.unwrap()).unwrap();
            let out = if input["action"].is_string() {
                access::execute(&mut c, serde_json::from_value(input).unwrap())
                    .unwrap_or_else(|e| json!({"isError":true,"status":409,"code":e}))
            } else {
                execute(
                    &mut c,
                    input["operationId"].as_str().unwrap(),
                    input["command"].as_str().unwrap(),
                    input["arguments"].clone(),
                )
            };
            println!("CICADA_FIXTURE:{}", out);
            std::io::stdout().flush().unwrap();
        }
    }
    fn call(c: &mut Connection, op: &str, cmd: &str, a: Value) -> Value {
        execute(c, op, cmd, a)
    }
    fn create(c: &mut Connection) -> Value {
        let x = call(
            c,
            "create-shared-001",
            "create",
            json!({"title":"Synthetic Ж 文","content":"Preserved description"}),
        );
        assert!(x.get("isError").is_none(), "{x}");
        x
    }
    fn report(run: &str, status: &str, n: u64) -> Value {
        json!({"runId":run,"sequence":n,"taskKey":null,"agent":"codex","provider":null,"model":null,"stage":null,"status":status,"skillIds":[],"mcpCalls":null,"inputTokens":null,"outputTokens":null})
    }
    fn observed(c: &mut Connection, id: &str, v: i64, run: &str) {
        let begin = json!({"title":"Ignored","content":"","taskId":id,"expectedVersion":v,"projects":[],"report":report(run,"running",1)});
        access::execute(
            c,
            access::Request {
                version: 1,
                operation_id: format!("begin-{run}"),
                action: "begin".into(),
                body: begin,
            },
        )
        .unwrap();
        finish(c, id, v, run);
    }
    fn finish(c: &mut Connection, id: &str, v: i64, run: &str) {
        access::execute(
            c,
            access::Request {
                version: 1,
                operation_id: format!("done-{run}"),
                action: "report".into(),
                body: json!({"taskId":id,"expectedVersion":v,"report":report(run,"done",2)}),
            },
        )
        .unwrap();
    }
    #[test]
    fn same_native_id_stages_and_replay() {
        let mut c = db();
        let first = create(&mut c);
        let id = first["task"]["id"].as_str().unwrap();
        assert_eq!(first, create(&mut c));
        let changed = call(
            &mut c,
            "patch-shared-001",
            "patch",
            json!({"taskId":id,"expectedVersion":1,"patch":{"stage":"requirements","process":"system-analysis"}}),
        );
        assert_eq!(changed["task"]["id"], id);
        assert!(changed["task"]["tags"]
            .as_str()
            .unwrap()
            .contains("task-stage-log:requirements@"));
        assert_eq!(
            call(
                &mut c,
                "stale-shared-001",
                "patch",
                json!({"taskId":id,"expectedVersion":1,"patch":{"title":"Lost"}})
            )["code"],
            "revision_conflict"
        );
        assert_eq!(
            call(
                &mut c,
                "create-shared-001",
                "create",
                json!({"title":"Changed","content":""})
            )["code"],
            "operation_payload_conflict"
        );
        assert_eq!(
            call(&mut c, "snapshot-001", "snapshot", json!({}))["tasks"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            c.query_row("SELECT count(*) FROM timeline_blocks", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    #[test]
    fn complete_review_rework_ack_and_history() {
        let mut c = db();
        let first = create(&mut c);
        let id = first["task"]["id"].as_str().unwrap();
        assert_eq!(
            call(
                &mut c,
                "result-early-001",
                "submit_result",
                json!({"taskId":id,"expectedVersion":1,"runId":"test-run-one","content":"Unobserved"})
            )["code"],
            "completed_execution_required"
        );
        observed(&mut c, id, 1, "test-run-one");
        let a = call(
            &mut c,
            "result-shared-001",
            "submit_result",
            json!({"taskId":id,"expectedVersion":1,"runId":"test-run-one","content":"First result"}),
        );
        assert_eq!(a["task"]["review"]["state"], "awaiting_review");
        let rework = call(
            &mut c,
            "rework-shared-001",
            "review",
            json!({"taskId":id,"expectedVersion":2,"resultVersion":1,"decision":"rework","comment":"Preserved feedback"}),
        );
        assert_eq!(rework["task"]["review"]["state"], "awaiting_dispatch");
        assert_eq!(rework["task"]["intents"][0]["state"], "awaiting_dispatch");
        let ack = call(
            &mut c,
            "ack-shared-001",
            "acknowledge",
            json!({"taskId":id,"expectedVersion":3,"intentId":"rework-shared-001","report":report("test-run-two","running",1)}),
        );
        assert_eq!(ack["task"]["review"]["state"], "running", "{ack}");
        finish(&mut c, id, 4, "test-run-two");
        let second = call(
            &mut c,
            "result-shared-002",
            "submit_result",
            json!({"taskId":id,"expectedVersion":4,"runId":"test-run-two","content":"Second result"}),
        );
        assert_eq!(
            second["task"]["results"].as_array().unwrap().len(),
            2,
            "{second}"
        );
        let accepted = call(
            &mut c,
            "accept-shared-002",
            "review",
            json!({"taskId":id,"expectedVersion":5,"resultVersion":2,"decision":"accept"}),
        );
        assert_eq!(accepted["task"]["completed"], true, "{accepted}");
        assert_eq!(accepted["task"]["results"][0]["content"], "First result");
        assert_eq!(
            accepted["task"]["history"][1]["comment"],
            "Preserved feedback"
        );
        assert_eq!(
            c.query_row("SELECT count(*) FROM timeline_blocks", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    #[test]
    fn scope_rechecked_before_receipt() {
        let mut c = db();
        let x = create(&mut c);
        let id = x["task"]["id"].as_str().unwrap();
        c.execute("UPDATE items SET tags='task-sphere:work' WHERE id=?1", [id])
            .unwrap();
        assert_eq!(create_replay(&mut c)["status"], 404);
        assert!(call(&mut c, "snapshot-001", "snapshot", json!({}))["tasks"]
            .as_array()
            .unwrap()
            .is_empty());
    }
    fn create_replay(c: &mut Connection) -> Value {
        call(
            c,
            "create-shared-001",
            "create",
            json!({"title":"Synthetic Ж 文","content":"Preserved description"}),
        )
    }
    #[test]
    fn legacy_workflow_survives_share_and_archive_retry() {
        let mut c = db();
        let item = crate::calendar_compat::create_note_in_transaction(
            &c,
            "Existing",
            "Description",
            "task-sphere:personal",
            "task",
            &None,
            None,
        )
        .unwrap();
        let id = item.id;
        access::write(
            &c,
            &format!("calendar_task_workflow_v1:{id}"),
            &json!({"savedResult":"Earlier manual result","steps":[]}),
        )
        .unwrap();
        let shared = call(
            &mut c,
            "share-existing-01",
            "share",
            json!({"taskId":id,"expectedVersion":1}),
        );
        assert_eq!(
            shared["task"]["workflow"]["savedResult"],
            "Earlier manual result"
        );
        let archived = call(
            &mut c,
            "archive-shared-01",
            "archive",
            json!({"taskId":id,"expectedVersion":2}),
        );
        assert_eq!(
            archived,
            call(
                &mut c,
                "archive-shared-01",
                "archive",
                json!({"taskId":id,"expectedVersion":2})
            )
        );
        let snap = call(&mut c, "snapshot-001", "snapshot", json!({}));
        assert_eq!(snap["tombstones"][0]["version"], 3);
        assert!(snap["tasks"].as_array().unwrap().is_empty());
    }
    #[test]
    fn operation_lookup_and_foreign_result_version() {
        let mut c = db();
        let a = create(&mut c);
        let id = a["task"]["id"].as_str().unwrap();
        assert_eq!(
            call(
                &mut c,
                "lookup-shared-001",
                "operation",
                json!({"operationId":"create-shared-001"})
            )["receipt"],
            a
        );
        observed(&mut c, id, 1, "test-run-one");
        call(
            &mut c,
            "result-shared-001",
            "submit_result",
            json!({"taskId":id,"expectedVersion":1,"runId":"test-run-one","content":"Result"}),
        );
        assert_eq!(
            call(
                &mut c,
                "review-stale-001",
                "review",
                json!({"taskId":id,"expectedVersion":2,"resultVersion":99,"decision":"accept"})
            )["code"],
            "stale_review_result"
        );
        assert_eq!(
            call(
                &mut c,
                "status-bypass-001",
                "patch",
                json!({"taskId":id,"expectedVersion":2,"patch":{"status":"done"}})
            )["code"],
            "review_controls_status"
        );
    }
}

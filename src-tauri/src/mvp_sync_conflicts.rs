//! Human decisions keep exact-version receipts and publish a fresh local write.
use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use sha2::{Digest, Sha256};
use tauri::{Emitter, State};

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Locator {
    source: String,
    id: String,
    stamp: String,
    writer: String,
    sender: String,
    kind: String,
}
struct Selected {
    location: Locator,
    data: String,
    record: Option<Record>,
}
#[derive(Clone)]
struct Current {
    data: String,
    stamp: String,
    writer: String,
    record: Record,
}

fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
fn payload_hash(record: &Record) -> Result<String, String> {
    Ok(digest(
        &serde_json::to_vec(record).map_err(|_| "mvp_sync_encode_failed")?,
    ))
}
pub(super) fn was_resolved(
    conn: &Connection,
    id: &str,
    stamp: &str,
    writer: &str,
    record: &Record,
) -> Result<bool, String> {
    sql(conn.query_row("SELECT EXISTS(SELECT 1 FROM mvp_sync_conflict_resolutions WHERE id=?1 AND stamp=?2 AND writer=?3 AND payload_hash=?4)",params![id,stamp,writer,payload_hash(record)?],|r|r.get(0)))
}
fn fields(
    id: &str,
    stamp: &str,
    writer: &str,
    record: &Record,
) -> Result<Map<String, Value>, String> {
    let data = serde_json::to_string(record).map_err(|_| "mvp_sync_encode_failed")?;
    Ok(
        json!({"id":id,"data":data,"updated_at":stamp,"_updated_at":stamp,"_device_id":writer})
            .as_object()
            .unwrap()
            .clone(),
    )
}
fn current(conn: &Connection, id: &str) -> Result<Option<Current>, String> {
    let row:Option<(String,String,String)>=sql(conn.query_row("SELECT r.data,r.updated_at,v.device_id FROM mvp_records r JOIN sync_row_versions v ON v.table_name='mvp_records' AND v.row_id=r.id WHERE r.id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional())?;
    row.map(|(data, stamp, writer)| {
        let record = serde_json::from_str(&data).map_err(|_| "mvp_sync_invalid_local_record")?;
        Ok(Current {
            data,
            stamp,
            writer,
            record,
        })
    })
    .transpose()
}
fn expected(selected: &Selected, current: Option<&Current>) -> Result<String, String> {
    let value = json!([
        selected.location,
        selected.data,
        current.map(|v| json!([v.data, v.stamp, v.writer]))
    ]);
    Ok(digest(
        &serde_json::to_vec(&value).map_err(|_| "mvp_sync_encode_failed")?,
    ))
}
fn parse_pending(location: Locator, data: String) -> Selected {
    let parsed = serde_json::from_str::<Value>(&data).ok();
    let record = parsed
        .as_ref()
        .filter(|v| v["t"] == "mvp_records" && location.kind == "row")
        .and_then(|v| v["f"].as_object())
        .and_then(|fields| decoded(fields).ok())
        .and_then(|(id, record, stamp, writer)| {
            (id == location.id && stamp == location.stamp && writer == location.writer)
                .then_some(record)
        });
    Selected {
        location,
        data,
        record,
    }
}
fn fetch(conn: &Connection, location: Locator) -> Result<Selected, String> {
    let data=match location.source.as_str(){
        "archive"=>sql(conn.query_row("SELECT data FROM mvp_sync_conflicts WHERE id=?1 AND stamp=?2 AND writer=?3",params![location.id,location.stamp,location.writer],|r|r.get::<_,String>(0)).optional())?,
        "pending" if exists(conn,"content_sync_pending")?=>sql(conn.query_row("SELECT payload FROM content_sync_pending WHERE sender=?1 AND table_name='mvp_records' AND remote_id=?2 AND kind=?3 AND stamp=?4",params![location.sender,location.id,location.kind,location.stamp],|r|r.get::<_,String>(0)).optional())?,
        _=>return Err("mvp_sync_conflict_invalid_selection".into()),
    }.ok_or("mvp_sync_conflict_stale")?;
    if location.source == "pending" {
        Ok(parse_pending(location, data))
    } else {
        let record = serde_json::from_str(&data).ok();
        Ok(Selected {
            location,
            data,
            record,
        })
    }
}
fn known(conn: &Connection, selected: &Selected) -> bool {
    selected
        .record
        .as_ref()
        .and_then(|record| {
            fields(
                &selected.location.id,
                &selected.location.stamp,
                &selected.location.writer,
                record,
            )
            .ok()
        })
        .is_some_and(|v| validate_record(conn, &v).is_ok())
}
fn incoming_allowed(
    conn: &Connection,
    selected: &Selected,
    current: Option<&Current>,
) -> Result<(), String> {
    if !known(conn, selected) {
        return Err("mvp_sync_conflict_unknown".into());
    }
    let record = selected
        .record
        .as_ref()
        .ok_or("mvp_sync_conflict_unknown")?;
    if let Some(current) = current {
        if current.record.kind != record.kind || current.record.key != record.key {
            return Err("mvp_sync_conflict_identity".into());
        }
        if current.record.deleted && !record.deleted {
            return Err("mvp_sync_conflict_deleted".into());
        }
        if record.kind == "timeline_blocks" && current.record.identity != record.identity {
            return Err("mvp_sync_conflict_identity".into());
        }
        if record.kind == "day" && current.record.value != record.value {
            return Err("mvp_sync_conflict_identity".into());
        }
        if matches!(
            record.kind.as_str(),
            "items" | "calendar_goals" | "event_categories"
        ) && !current.record.deleted
            && !record.deleted
            && current.record.value["created_at"] != record.value["created_at"]
        {
            return Err("mvp_sync_conflict_identity".into());
        }
        if matches!(
            record.kind.as_str(),
            "items" | "calendar_goals" | "event_categories"
        ) && record.deleted
            && !current.record.deleted
            && !(record.parent.as_deref() == Some(current.stamp.as_str())
                && record.parent_writer.as_deref() == Some(current.writer.as_str()))
        {
            // Older tombstones lack a birth identity. Do not delete a later incarnation.
            return Err("mvp_sync_conflict_identity".into());
        }
    }
    // Resolving history must not replace a running timer or reconnect a stale execution.
    if record.kind == "items" {
        let active: bool = sql(conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM timeline_blocks WHERE source_id=?1 AND is_active=1)",
            [json_sql(&record.key[0])?],
            |r| r.get(0),
        ))?;
        if active {
            return Err("mvp_sync_conflict_active_timer".into());
        }
    }
    if record.kind == "timeline_blocks" {
        if record.value["is_active"] == 1
            || current.is_some_and(|v| v.record.value["is_active"] == 1)
        {
            return Err("mvp_sync_conflict_active_timer".into());
        }
    }
    if record.kind == "ui" && record.key.first().and_then(Value::as_str) == Some("calendar_now_v1")
    {
        let active: bool = sql(conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM timeline_blocks WHERE is_active=1)",
            [],
            |r| r.get(0),
        ))?;
        if active {
            return Err("mvp_sync_conflict_active_timer".into());
        }
        if !record.value["execution"].is_null() {
            return Err("mvp_sync_conflict_execution".into());
        }
    }
    if record.kind == "day" {
        let (id, stamp) = day_entry(&record.value)?;
        let prior: Option<String> = sql(conn
            .query_row(
                "SELECT started_at_utc FROM mvp_day_starts WHERE id=?1",
                [id],
                |r| r.get(0),
            )
            .optional())?;
        if prior.is_some_and(|v| v != stamp) {
            return Err("mvp_sync_conflict_identity".into());
        }
    }
    if record.kind == "ui"
        && !record.deleted
        && record.key.first().and_then(Value::as_str) == Some("calendar_development_v1")
    {
        let goal = record.key[1].as_str().ok_or("mvp_sync_conflict_unknown")?;
        let exists: bool = sql(conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM calendar_goals WHERE id=?1)",
            [goal],
            |r| r.get(0),
        ))?;
        if !exists {
            return Err("content_sync_parent_missing".into());
        }
    }
    if TABLES.iter().any(|(name, _)| *name == record.kind) {
        check_relations(conn, record)?;
    }
    if record.kind == "event_categories" && record.deleted {
        let linked: bool = sql(conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM items WHERE kind='event' AND category=?1)",
            [json_sql(&record.key[0])?],
            |r| r.get(0),
        ))?;
        if linked {
            return Err("content_sync_dependent_records".into());
        }
    }
    Ok(())
}
fn shortened(value: &str, limit: usize) -> String {
    let mut chars = value.chars();
    let mut result: String = chars.by_ref().take(limit).collect();
    if chars.next().is_some() {
        result.push('…');
    }
    result
}
fn title(record: &Record) -> Option<String> {
    [
        record.value.get("title"),
        record.value.get("name"),
        record.value.get("row").and_then(|v| v.get("title")),
        record.value.get("snapshot").and_then(|v| v.get("title")),
    ]
    .into_iter()
    .flatten()
    .find_map(|v| {
        v.as_str()
            .filter(|v| !v.is_empty())
            .map(|v| shortened(v, 160))
    })
}
fn entity(record: &Record) -> &'static str {
    match record.kind.as_str() {
        "items" if record.value["kind"] == "event" => "Событие",
        "items" if record.value["status"] == "note" => "Заметка",
        "items" => "Задача",
        "calendar_goals" => "Цель",
        "calendar_task_goals" => "Связь задачи и цели",
        "event_categories" => "Категория",
        "timeline_blocks" => "История работы",
        "day" => "Начало дня",
        "ui" => match record.key.first().and_then(Value::as_str) {
            Some("calendar_development_v1") => "Развитие цели",
            Some("calendar_recurring_v1") => "Дело или правило",
            Some("calendar_now_v1") => "Текущая задача и цель",
            _ => "Запись",
        },
        _ => "Запись неизвестного формата",
    }
}
fn linked_title(conn: &Connection, table: &str, id: &Value) -> Result<Option<String>, String> {
    let Some(id) = id.as_str() else {
        return Ok(None);
    };
    sql(conn
        .query_row(
            &format!("SELECT title FROM {table} WHERE id=?1"),
            [id],
            |r| r.get::<_, String>(0),
        )
        .optional())
    .map(|title| title.map(|v| shortened(&v, 160)))
}
fn preview(
    conn: &Connection,
    record: Option<&Record>,
    stamp: Option<&str>,
    readable: bool,
) -> Result<Value, String> {
    if !readable {
        return Ok(json!({"state":"unknown","fields":[],"updated_at":stamp}));
    }
    let Some(record) = record else {
        return Ok(json!({"state":"absent","fields":[],"updated_at":stamp}));
    };
    if record.deleted {
        return Ok(json!({"state":"deleted","fields":[],"updated_at":stamp}));
    }
    let value = if record.kind == "ui" && record.value.get("row").is_some() {
        &record.value["row"]
    } else {
        &record.value
    };
    let mut rows = Vec::new();
    for (key, label) in [
        ("title", "Название"),
        ("name", "Название"),
        ("notes", "Текст"),
        ("description", "Описание"),
        ("criteria", "Критерии"),
        ("evidence", "Результат"),
        ("outcome", "Результат"),
        ("topic", "Тема"),
        ("date", "Дата"),
        ("deadline", "Срок"),
        ("time", "Время"),
        ("start_time", "Начало"),
        ("end_time", "Окончание"),
        ("status", "Состояние"),
        ("started_at_utc", "Начало дня"),
        ("duration_seconds", "Секунды работы"),
    ] {
        if let Some(text) = value
            .get(key)
            .and_then(|v| {
                v.as_str()
                    .map(str::to_owned)
                    .or_else(|| v.as_i64().map(|n| n.to_string()))
            })
            .filter(|s| !s.is_empty())
        {
            rows.push(json!({"label":label,"value":shortened(&text,600)}));
        }
        if rows.len() == 6 {
            break;
        }
    }
    // Task kind and sphere (#96) live in `tags`. Without them two versions that
    // differ only there would look identical in the review.
    if record.kind == "items" && value["kind"] == "task" && value["status"] != "note" {
        let tags = value["tags"].as_str().unwrap_or("");
        rows.push(json!({"label":"Вид","value":crate::task_attributes::kind_label(crate::task_attributes::kind(tags))}));
        if let Some(sphere) = crate::task_attributes::sphere(tags) {
            rows.push(json!({"label":"Сфера","value":crate::task_attributes::sphere_label(sphere)}));
        }
    }
    if matches!(
        record.kind.as_str(),
        "calendar_task_goals" | "timeline_blocks"
    ) {
        let text = linked_title(conn, "items", &value["source_id"])?
            .unwrap_or_else(|| "Связанная запись ещё не получена или удалена".into());
        rows.insert(0, json!({"label":"Задача или событие","value":text}));
    }
    if record.kind == "calendar_task_goals"
        || (record.kind == "calendar_goals" && !value["parent_goal_id"].is_null())
    {
        let id = if record.kind == "calendar_task_goals" {
            &value["goal_id"]
        } else {
            &value["parent_goal_id"]
        };
        let text = linked_title(conn, "calendar_goals", id)?
            .unwrap_or_else(|| "Цель ещё не получена или удалена".into());
        rows.push(json!({"label":if record.kind=="calendar_goals"{"Родительская цель"}else{"Цель"},"value":text}));
    }
    if record.kind == "ui"
        && record.key.first().and_then(Value::as_str) == Some("calendar_development_v1")
    {
        let text = linked_title(conn, "calendar_goals", &record.key[1])?
            .unwrap_or_else(|| "Цель ещё не получена или удалена".into());
        rows.insert(0, json!({"label":"Цель","value":text}));
    }
    if let Some(text) = value
        .get("snapshot")
        .and_then(|v| v.get("title"))
        .and_then(Value::as_str)
    {
        rows.insert(0, json!({"label":"Название","value":shortened(text,160)}));
    }
    if record.kind == "ui" && record.key.first().and_then(Value::as_str) == Some("calendar_now_v1")
    {
        if let Some(text) = value
            .get("selection")
            .and_then(|v| v.get("title"))
            .and_then(Value::as_str)
        {
            rows.push(json!({"label":"Выбранная задача","value":shortened(text,160)}));
        }
        rows.push(json!({"label":"Выбор задачи","value":if value["selectionMode"]=="manual"{"Вручную"}else{"Автоматически"}}));
    }
    Ok(json!({"state":"present","fields":rows,"updated_at":stamp}))
}
fn entry(conn: &Connection, selected: Selected) -> Result<Value, String> {
    let current = current(conn, &selected.location.id)?;
    let readable = known(conn, &selected);
    let label = selected
        .record
        .as_ref()
        .filter(|_| readable)
        .map(|record| {
            let name = title(record).or_else(|| current.as_ref().and_then(|v| title(&v.record)));
            match name {
                Some(name) => format!("{}: {name}", entity(record)),
                None => entity(record).to_string(),
            }
        })
        .unwrap_or_else(|| "Запись неизвестного формата".into());
    let allowed = incoming_allowed(conn, &selected, current.as_ref());
    let token =
        B64.encode(serde_json::to_vec(&selected.location).map_err(|_| "mvp_sync_encode_failed")?);
    Ok(
        json!({"token":token,"expected":expected(&selected,current.as_ref())?,"source":selected.location.source,"label":label,"reason":allowed.as_ref().err(),"current":preview(conn,current.as_ref().map(|v|&v.record),current.as_ref().map(|v|v.stamp.as_str()),readable)?,"incoming":preview(conn,selected.record.as_ref(),Some(&selected.location.stamp),readable)?,"can_keep_current":readable,"can_use_incoming":allowed.is_ok()}),
    )
}
fn list(conn: &Connection, offset: usize, limit: usize) -> Result<Value, String> {
    if limit == 0 || limit > 50 || offset > 1_000_000 {
        return Err("mvp_sync_conflict_invalid_page".into());
    }
    let pending = exists(conn, "content_sync_pending")?;
    let query = if pending {
        "SELECT 'archive',id,stamp,writer,'','',data FROM mvp_sync_conflicts UNION ALL SELECT 'pending',remote_id,stamp,CASE WHEN json_valid(payload) THEN CASE WHEN json_type(payload,'$.f._device_id')='text' THEN json_extract(payload,'$.f._device_id') ELSE '' END ELSE '' END,sender,kind,payload FROM content_sync_pending WHERE table_name='mvp_records' ORDER BY 3 DESC,1,2,4 LIMIT ?1 OFFSET ?2"
    } else {
        "SELECT 'archive',id,stamp,writer,'','',data FROM mvp_sync_conflicts ORDER BY stamp DESC,id,writer LIMIT ?1 OFFSET ?2"
    };
    let mut statement = sql(conn.prepare(query))?;
    let rows = sql(
        statement.query_map(params![limit as i64, offset as i64], |r| {
            Ok((
                Locator {
                    source: r.get(0)?,
                    id: r.get(1)?,
                    stamp: r.get(2)?,
                    writer: r.get(3)?,
                    sender: r.get(4)?,
                    kind: r.get(5)?,
                },
                r.get::<_, String>(6)?,
            ))
        }),
    )?;
    let mut entries = Vec::new();
    for row in rows {
        let (location, data) = sql(row)?;
        let selected = if location.source == "pending" {
            parse_pending(location, data)
        } else {
            let record = serde_json::from_str(&data).ok();
            Selected {
                location,
                data,
                record,
            }
        };
        entries.push(entry(conn, selected)?);
    }
    let archive: i64 =
        sql(conn.query_row("SELECT count(*) FROM mvp_sync_conflicts", [], |r| r.get(0)))?;
    let pending_count: i64 = if pending {
        sql(conn.query_row(
            "SELECT count(*) FROM content_sync_pending WHERE table_name='mvp_records'",
            [],
            |r| r.get(0),
        ))?
    } else {
        0
    };
    Ok(json!({"total":archive+pending_count,"offset":offset,"entries":entries}))
}
fn revision(conn: &Connection) -> Result<String, String> {
    let receive: i64 = if exists(conn, "content_sync_state")? {
        sql(conn
            .query_row(
                "SELECT receive_seq FROM content_sync_state WHERE id=1",
                [],
                |r| r.get(0),
            )
            .optional())?
        .unwrap_or(0)
    } else {
        0
    };
    let recovered: i64 = if exists(conn, "content_sync_pending_meta")? {
        sql(conn.query_row(
            "SELECT recovered_count FROM content_sync_pending_meta WHERE id=1",
            [],
            |r| r.get(0),
        ))?
    } else {
        0
    };
    Ok((receive + recovered).to_string())
}
fn resolve(
    conn: &mut Connection,
    token: &str,
    expected_value: &str,
    choice: &str,
) -> Result<Value, String> {
    if token.len() > 4096 || expected_value.len() != 64 || !matches!(choice, "current" | "incoming")
    {
        return Err("mvp_sync_conflict_invalid_selection".into());
    }
    let bytes = B64
        .decode(token)
        .map_err(|_| "mvp_sync_conflict_invalid_selection")?;
    let location: Locator =
        serde_json::from_slice(&bytes).map_err(|_| "mvp_sync_conflict_invalid_selection")?;
    let tx = sql(conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate))?;
    let selected = fetch(&tx, location)?;
    let current = current(&tx, &selected.location.id)?;
    if expected(&selected, current.as_ref())? != expected_value {
        return Err("mvp_sync_conflict_stale".into());
    }
    if !known(&tx, &selected) {
        return Err("mvp_sync_conflict_unknown".into());
    }
    let record = selected
        .record
        .as_ref()
        .ok_or("mvp_sync_conflict_unknown")?;
    if choice == "incoming" {
        incoming_allowed(&tx, &selected, current.as_ref())?;
        let remote_millis = DateTime::parse_from_rfc3339(&selected.location.stamp)
            .map_err(|_| "mvp_sync_conflict_unknown")?
            .timestamp_millis();
        sql(tx.execute(
            "UPDATE mvp_sync_meta SET clock=MAX(clock,?1) WHERE id=1",
            [remote_millis],
        ))?;
        let mut next = record.clone();
        next.parent = current.as_ref().map(|v| v.stamp.clone());
        next.parent_writer = current.as_ref().map(|v| v.writer.clone());
        let stamp = clock(&tx)?;
        let writer = get_setting_checked(&tx, "device_id")?.ok_or("mvp_sync_missing_writer")?;
        // Suppress capture while projecting, then enqueue the exact chosen record once.
        let entered = sql(tx.execute(
            "UPDATE content_sync_control SET applying=1 WHERE id=1 AND applying=0",
            [],
        ))?;
        if entered != 1 {
            return Err("mvp_sync_conflict_busy".into());
        }
        store(&tx, &selected.location.id, &next, &stamp, &writer)?;
        materialize(&tx, &next)?;
        sql(tx.execute("UPDATE content_sync_control SET applying=0 WHERE id=1", []))?;
        sql(tx.execute(
            "DELETE FROM content_sync_dirty WHERE table_name='mvp_records' AND row_id=?1",
            [&selected.location.id],
        ))?;
        sql(tx.execute(
            "INSERT INTO content_sync_dirty(table_name,row_id) VALUES('mvp_records',?1)",
            [&selected.location.id],
        ))?;
        if exists(&tx, "content_sync_pending_meta")? {
            sql(tx.execute(
                "UPDATE content_sync_pending_meta SET recovered_count=recovered_count+1 WHERE id=1",
                [],
            ))?;
        }
    }
    sql(tx.execute("INSERT OR IGNORE INTO mvp_sync_resolution_archive(id,stamp,writer,payload_hash,data,source) VALUES(?1,?2,?3,?4,?5,?6)",params![selected.location.id,selected.location.stamp,selected.location.writer,payload_hash(record)?,serde_json::to_string(record).map_err(|_|"mvp_sync_encode_failed")?,selected.location.source]))?;
    sql(tx.execute(
        "INSERT OR IGNORE INTO mvp_sync_conflict_resolutions VALUES(?1,?2,?3,?4,?5,?6)",
        params![
            selected.location.id,
            selected.location.stamp,
            selected.location.writer,
            payload_hash(record)?,
            choice,
            Utc::now().to_rfc3339()
        ],
    ))?;
    let removed = if selected.location.source == "archive" {
        sql(tx.execute(
            "DELETE FROM mvp_sync_conflicts WHERE id=?1 AND stamp=?2 AND writer=?3 AND data=?4",
            params![
                selected.location.id,
                selected.location.stamp,
                selected.location.writer,
                selected.data
            ],
        ))?
    } else {
        sql(tx.execute("DELETE FROM content_sync_pending WHERE sender=?1 AND table_name='mvp_records' AND remote_id=?2 AND kind=?3 AND stamp=?4 AND payload=?5",params![selected.location.sender,selected.location.id,selected.location.kind,selected.location.stamp,selected.data]))?
    };
    if removed != 1 {
        return Err("mvp_sync_conflict_stale".into());
    }
    let result =
        json!({"resolved":true,"views_changed":choice=="incoming","revision":revision(&tx)?});
    sql(tx.commit())?;
    Ok(result)
}

#[tauri::command]
pub(crate) fn mvp_sync_conflicts_list(
    offset: Option<usize>,
    limit: Option<usize>,
    state: State<'_, crate::AppState>,
) -> Result<Value, String> {
    let conn = state.0.lock().map_err(|_| "mvp_sync_conflict_busy")?;
    list(&conn, offset.unwrap_or(0), limit.unwrap_or(25))
}
#[tauri::command]
pub(crate) fn mvp_sync_conflict_resolve(
    token: String,
    expected: String,
    choice: String,
    app: tauri::AppHandle,
    state: State<'_, crate::AppState>,
) -> Result<Value, String> {
    let mut conn = state.0.lock().map_err(|_| "mvp_sync_conflict_busy")?;
    let result = resolve(&mut conn, &token, &expected, &choice)?;
    let _ = app.emit(
        "mvp-sync-updated",
        json!({"views_changed":result["views_changed"],"revision":result["revision"]}),
    );
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        crate::init_schema(&c).unwrap();
        c
    }
    fn task(conn: &Connection, id: &str, title: &str) {
        conn.execute("INSERT INTO items(id,kind,title,duration_minutes,version,created_at,updated_at) VALUES(?1,'task',?2,30,1,'2026-09-14T00:00:00Z','2026-09-14T00:00:00Z')",params![id,title]).unwrap();
    }
    fn archive(conn: &Connection, id: &str, title: &str) -> (String, Record) {
        let id = key("items", &[json!(id)]);
        let mut row = current(conn, &id).unwrap().unwrap().record;
        row.value["title"] = json!(title);
        let data = serde_json::to_string(&row).unwrap();
        conn.execute(
            "INSERT INTO mvp_sync_conflicts VALUES(?1,'2026-09-14T01:00:00.000Z','peer',?2)",
            params![id, data],
        )
        .unwrap();
        (id, row)
    }
    fn choose(conn: &mut Connection, entry: &Value, choice: &str) -> Result<Value, String> {
        resolve(
            conn,
            entry["token"].as_str().unwrap(),
            entry["expected"].as_str().unwrap(),
            choice,
        )
    }
    #[test]
    fn review_preview_names_task_kind_and_sphere_but_not_for_notes() {
        let c = fixture();
        c.execute("INSERT INTO items(id,kind,title,duration_minutes,version,created_at,updated_at,tags,status) VALUES('t','task','Fictional',0,1,'a','a','task-kind:instant,task-sphere:health','task'),('n','task','Note',30,1,'a','a','task-sphere:health','note'),('p','task','Plain',0,1,'a','a','','task')", []).unwrap();
        let fields = |id: &str| {
            let record = current(&c, &key("items", &[json!(id)])).unwrap().unwrap().record;
            preview(&c, Some(&record), Some("2026-09-24T00:00:00.000Z"), true).unwrap()["fields"].as_array().unwrap().clone()
        };
        let task = fields("t");
        assert!(task.contains(&json!({"label":"Вид","value":"Моментальная"})), "{task:?}");
        assert!(task.contains(&json!({"label":"Сфера","value":"Здоровье"})), "{task:?}");
        let plain = fields("p");
        assert!(plain.contains(&json!({"label":"Вид","value":"Обычная"})));
        assert!(!plain.iter().any(|row| row["label"] == "Сфера"));
        assert!(!fields("n").iter().any(|row| row["label"] == "Вид" || row["label"] == "Сфера"));
    }
    #[test]
    fn selected_alternative_becomes_a_new_local_version_and_only_it_is_removed() {
        let mut c = fixture();
        task(&c, "task", "Current");
        let (id, old) = archive(&c, "task", "Selected");
        c.execute(
            "INSERT INTO mvp_sync_conflicts VALUES(?1,'2026-09-14T02:00:00.000Z','another',?2)",
            params![id, serde_json::to_string(&old).unwrap()],
        )
        .unwrap();
        let entry = list(&c, 0, 25).unwrap()["entries"][1].clone();
        let before = current(&c, &id).unwrap().unwrap();
        choose(&mut c, &entry, "incoming").unwrap();
        let after = current(&c, &id).unwrap().unwrap();
        assert!(after.stamp > before.stamp);
        assert_eq!(
            after.writer,
            get_setting_checked(&c, "device_id").unwrap().unwrap()
        );
        assert_eq!(after.record.value["title"], "Selected");
        assert_eq!(
            c.query_row("SELECT title FROM items WHERE id='task'", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "Selected"
        );
        assert_eq!(
            c.query_row("SELECT count(*) FROM mvp_sync_conflicts", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            c.query_row(
                "SELECT count(*) FROM content_sync_dirty WHERE row_id=?1",
                [id],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
    }
    #[test]
    fn concurrent_update_after_opening_rejects_both_choices_without_dropping_archive() {
        let mut c = fixture();
        task(&c, "task", "Current");
        archive(&c, "task", "Other");
        let entry = list(&c, 0, 25).unwrap()["entries"][0].clone();
        c.execute(
            "UPDATE items SET title='New current',version=version+1 WHERE id='task'",
            [],
        )
        .unwrap();
        for choice in ["current", "incoming"] {
            assert_eq!(
                choose(&mut c, &entry, choice).unwrap_err(),
                "mvp_sync_conflict_stale"
            );
        }
        assert_eq!(list(&c, 0, 25).unwrap()["total"], 1);
    }
    #[test]
    fn keep_current_receipt_blocks_repeated_archive_and_replay_of_exact_version() {
        let mut c = fixture();
        task(&c, "task", "Current");
        let (id, row) = archive(&c, "task", "Old");
        let entry = list(&c, 0, 25).unwrap()["entries"][0].clone();
        choose(&mut c, &entry, "current").unwrap();
        keep_conflict(&c, &id, "2026-09-14T01:00:00.000Z", "peer", &row).unwrap();
        assert_eq!(list(&c, 0, 25).unwrap()["total"], 0);
        assert!(!apply_record(
            &c,
            &fields(&id, "2026-09-14T01:00:00.000Z", "peer", &row).unwrap()
        )
        .unwrap());
    }
    #[test]
    fn deleted_current_record_cannot_be_resurrected_from_archive() {
        let mut c = fixture();
        task(&c, "task", "Current");
        archive(&c, "task", "Old");
        c.execute("DELETE FROM items WHERE id='task'", []).unwrap();
        let entry = list(&c, 0, 25).unwrap()["entries"][0].clone();
        assert_eq!(entry["can_use_incoming"], false);
        assert_eq!(
            choose(&mut c, &entry, "incoming").unwrap_err(),
            "mvp_sync_conflict_deleted"
        );
        choose(&mut c, &entry, "current").unwrap();
        assert_eq!(
            c.query_row("SELECT count(*) FROM items WHERE id='task'", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    #[test]
    fn unknown_payload_is_read_only_and_never_returned_as_preview() {
        let mut c = fixture();
        c.execute(
            "INSERT INTO mvp_sync_conflicts VALUES('foreign','2026-09-14T01:00:00.000Z','peer',?1)",
            ["{\"token\":\"fictional-hidden-secret\"}"],
        )
        .unwrap();
        let result = list(&c, 0, 25).unwrap();
        assert!(!result.to_string().contains("fictional-hidden-secret"));
        let entry = &result["entries"][0];
        assert_eq!(entry["can_keep_current"], false);
        assert_eq!(entry["can_use_incoming"], false);
        assert_eq!(
            choose(&mut c, entry, "current").unwrap_err(),
            "mvp_sync_conflict_unknown"
        );
    }
    fn pending(conn: &Connection, record: &Record, stamp: &str) -> String {
        let id = key(&record.kind, &record.key);
        let payload =
            json!({"t":"mvp_records","f":fields(&id,stamp,"peer",record).unwrap()}).to_string();
        conn.execute_batch("CREATE TABLE IF NOT EXISTS content_sync_pending(sender TEXT NOT NULL,table_name TEXT NOT NULL,remote_id TEXT NOT NULL,kind TEXT NOT NULL,stamp TEXT NOT NULL,payload TEXT NOT NULL,error_code TEXT NOT NULL,last_attempt INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(sender,table_name,remote_id,kind)); CREATE TABLE IF NOT EXISTS content_sync_pending_meta(id INTEGER PRIMARY KEY,recovered_count INTEGER NOT NULL,retry_seq INTEGER NOT NULL DEFAULT 0); INSERT OR IGNORE INTO content_sync_pending_meta VALUES(1,0,0);").unwrap();
        conn.execute("INSERT INTO content_sync_pending(sender,table_name,remote_id,kind,stamp,payload,error_code) VALUES('sender','mvp_records',?1,'row',?2,?3,'content_sync_parent_missing') ON CONFLICT(sender,table_name,remote_id,kind) DO UPDATE SET stamp=excluded.stamp,payload=excluded.payload",params![id,stamp,payload]).unwrap();
        id
    }
    #[test]
    fn pending_relation_is_blocked_until_parent_exists_then_becomes_a_fresh_local_write() {
        let mut c = fixture();
        task(&c, "task", "Linked task");
        let row = Record {
            v: 1,
            kind: "calendar_task_goals".into(),
            key: vec![json!("note"), json!("task")],
            value: json!({"source_type":"note","source_id":"task","goal_id":"parent","created_at":"2026-09-14T00:00:00Z"}),
            deleted: false,
            identity: None,
            parent: None,
            parent_writer: None,
        };
        let id = pending(&c, &row, "2026-09-14T01:00:00.000Z");
        let entry = list(&c, 0, 25).unwrap()["entries"][0].clone();
        assert_eq!(entry["can_use_incoming"], false);
        assert_eq!(
            choose(&mut c, &entry, "incoming").unwrap_err(),
            "content_sync_parent_missing"
        );
        assert_eq!(
            c.query_row("SELECT count(*) FROM content_sync_pending", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        c.execute("INSERT INTO calendar_goals(id,title,created_at,updated_at) VALUES('parent','Parent','2026-09-14T00:00:00Z','2026-09-14T00:00:00Z')",[]).unwrap();
        let entry = list(&c, 0, 25).unwrap()["entries"][0].clone();
        assert_eq!(entry["can_use_incoming"], true);
        let result = choose(&mut c, &entry, "incoming").unwrap();
        assert_eq!(result["views_changed"], true);
        assert_eq!(
            c.query_row("SELECT count(*) FROM content_sync_pending", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert!(current(&c, &id).unwrap().unwrap().stamp.as_str() > "2026-09-14T01:00:00.000Z");
        assert_eq!(
            c.query_row(
                "SELECT goal_id FROM calendar_task_goals WHERE source_id='task'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "parent"
        );
    }
    #[test]
    fn dismissal_of_one_pending_version_keeps_newer_incoming_versions_available() {
        let mut c = fixture();
        task(&c, "task", "Current");
        let id = key("items", &[json!("task")]);
        let mut row = current(&c, &id).unwrap().unwrap().record;
        row.value["title"] = json!("Alternative");
        pending(&c, &row, "2026-09-14T01:00:00.000Z");
        let old = list(&c, 0, 25).unwrap()["entries"][0].clone();
        choose(&mut c, &old, "current").unwrap();
        assert!(!apply_record(
            &c,
            &fields(&id, "2026-09-14T01:00:00.000Z", "peer", &row).unwrap()
        )
        .unwrap());
        pending(&c, &row, "2026-09-14T02:00:00.000Z");
        assert_eq!(list(&c, 0, 25).unwrap()["total"], 1);
        assert_eq!(
            choose(&mut c, &old, "current").unwrap_err(),
            "mvp_sync_conflict_stale"
        );
    }
    #[test]
    fn colliding_legacy_timeline_tombstone_cannot_delete_the_current_entity() {
        let mut c = fixture();
        c.execute("INSERT INTO timeline_blocks(id,source_type,source_id,date,start_time,created_at,updated_at) VALUES(1,'note','first','2026-09-14','08:00','2026-09-14T00:00:00Z','2026-09-14T00:00:00Z')",[]).unwrap();
        let id = key("timeline_blocks", &[json!(1)]);
        let mut row = current(&c, &id).unwrap().unwrap().record;
        row.identity = Some(json!(["2026-09-14T00:00:00Z", "note", "other"]));
        row.deleted = true;
        row.value = Value::Null;
        pending(&c, &row, "2026-09-14T01:00:00.000Z");
        let entry = list(&c, 0, 25).unwrap()["entries"][0].clone();
        assert_eq!(entry["can_use_incoming"], false);
        assert_eq!(
            choose(&mut c, &entry, "incoming").unwrap_err(),
            "mvp_sync_conflict_identity"
        );
        choose(&mut c, &entry, "current").unwrap();
        assert_eq!(
            c.query_row(
                "SELECT source_id FROM timeline_blocks WHERE id=1",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "first"
        );
    }
    #[test]
    fn an_old_tombstone_without_birth_identity_cannot_delete_a_reused_text_id() {
        let mut c = fixture();
        task(&c, "task", "Old incarnation");
        let id = key("items", &[json!("task")]);
        c.execute("DELETE FROM items WHERE id='task'", []).unwrap();
        let tomb = current(&c, &id).unwrap().unwrap().record;
        task(&c, "task", "New incarnation");
        pending(&c, &tomb, "2026-09-14T01:00:00.000Z");
        let entry = list(&c, 0, 25).unwrap()["entries"][0].clone();
        assert_eq!(
            choose(&mut c, &entry, "incoming").unwrap_err(),
            "mvp_sync_conflict_identity"
        );
        assert_eq!(
            c.query_row("SELECT title FROM items WHERE id='task'", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "New incarnation"
        );
    }
    #[test]
    fn failed_materialization_rolls_back_shadow_clock_queue_and_resolution() {
        let mut c = fixture();
        task(&c, "task", "Current");
        let (id, mut row) = archive(&c, "task", "Other");
        row.value["kind"] = json!("unsupported");
        c.execute(
            "UPDATE mvp_sync_conflicts SET data=?1",
            [serde_json::to_string(&row).unwrap()],
        )
        .unwrap();
        let before = current(&c, &id).unwrap().unwrap();
        let dirty: i64 = c
            .query_row("SELECT count(*) FROM content_sync_dirty", [], |r| r.get(0))
            .unwrap();
        let entry = list(&c, 0, 25).unwrap()["entries"][0].clone();
        assert!(choose(&mut c, &entry, "incoming").is_err());
        assert_eq!(current(&c, &id).unwrap().unwrap().data, before.data);
        assert_eq!(current(&c, &id).unwrap().unwrap().stamp, before.stamp);
        assert_eq!(
            c.query_row("SELECT count(*) FROM content_sync_dirty", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            dirty
        );
        assert_eq!(
            c.query_row(
                "SELECT count(*) FROM mvp_sync_conflict_resolutions",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        assert_eq!(
            c.query_row("SELECT applying FROM content_sync_control", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(list(&c, 0, 25).unwrap()["total"], 1);
    }
    #[test]
    fn checkpoint_restore_preserves_exact_dismissals_and_rejects_payload_equivocation() {
        let mut c = fixture();
        task(&c, "task", "Current");
        archive(&c, "task", "Other");
        let saved = checkpoint_conflicts(&c).unwrap();
        assert_eq!(saved.len(), 1);
        let mut changed = saved[0].clone();
        let mut payload: Value = serde_json::from_str(changed["data"].as_str().unwrap()).unwrap();
        payload["value"]["title"] = json!("Different payload at same version");
        changed["data"] = json!(payload.to_string());
        assert_eq!(
            checkpoint_merge_conflict(&c, &changed).unwrap_err(),
            "content_sync_version_conflict"
        );
        let entry = list(&c, 0, 25).unwrap()["entries"][0].clone();
        choose(&mut c, &entry, "current").unwrap();
        initialize(&c).unwrap();
        checkpoint_merge_conflict(&c, &saved[0]).unwrap();
        assert_eq!(checkpoint_conflicts(&c).unwrap().len(), 1);
        assert_eq!(list(&c, 0, 25).unwrap()["total"], 0);
        assert!(checkpoint_publishable(&c).unwrap());
        let other = fixture();
        checkpoint_merge_conflict(&other, &saved[0]).unwrap();
        assert_eq!(checkpoint_conflicts(&other).unwrap().len(), 1);
    }
    #[test]
    fn an_active_task_cannot_be_replaced_by_historical_content() {
        let mut c = fixture();
        task(&c, "task", "Current");
        archive(&c, "task", "Other");
        c.execute("INSERT INTO timeline_blocks(id,source_type,source_id,date,start_time,is_active,created_at,updated_at) VALUES(1,'note','task','2026-09-14','08:00',1,'2026-09-14T00:00:00Z','2026-09-14T00:00:00Z')",[]).unwrap();
        let entry = list(&c, 0, 25).unwrap()["entries"][0].clone();
        assert_eq!(
            choose(&mut c, &entry, "incoming").unwrap_err(),
            "mvp_sync_conflict_active_timer"
        );
        assert_eq!(
            c.query_row(
                "SELECT is_active FROM timeline_blocks WHERE id=1",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
    }
    #[test]
    fn dismissing_pending_keeps_its_payload_hidden_and_permanently_blocks_publication() {
        let mut c = fixture();
        task(&c, "task", "Current");
        let id = key("items", &[json!("task")]);
        let mut record = current(&c, &id).unwrap().unwrap().record;
        record.value["title"] = json!("Other device's version");
        pending(&c, &record, "2026-09-14T01:00:00.000Z");
        let entry = list(&c, 0, 25).unwrap()["entries"][0].clone();
        choose(&mut c, &entry, "current").unwrap();
        initialize(&c).unwrap();
        assert_eq!(list(&c, 0, 25).unwrap()["total"], 0);
        assert!(!checkpoint_publishable(&c).unwrap());
        let saved = checkpoint_conflicts(&c).unwrap();
        assert_eq!(saved.len(), 1);
        assert_eq!(
            serde_json::from_str::<Value>(saved[0]["data"].as_str().unwrap()).unwrap()["value"]
                ["title"],
            "Other device's version"
        );
        checkpoint_merge_conflict(&c, &saved[0]).unwrap();
        assert_eq!(list(&c, 0, 25).unwrap()["total"], 0);
        let cold = fixture();
        checkpoint_merge_conflict(&cold, &saved[0]).unwrap();
        assert_eq!(list(&cold, 0, 25).unwrap()["total"], 1);
    }
    #[test]
    fn receipt_without_retained_provenance_cannot_certify_a_checkpoint_prefix() {
        let c = fixture();
        assert!(checkpoint_publishable(&c).unwrap());
        c.execute("INSERT INTO mvp_sync_conflict_resolutions VALUES('old','2026-09-14T00:00:00.000Z','peer','missing','current','2026-09-14T00:00:00Z')",[]).unwrap();
        initialize(&c).unwrap();
        assert!(!checkpoint_publishable(&c).unwrap());
    }
}

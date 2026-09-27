use super::*;
use serde_json::Map;

pub(crate) fn fixture_state() -> Value {
    json!({"version":1,"plans":[{"id":"plan","kind":"action","title":"Reflection fixture","mode":"check","weekdays":[0,1,2,3,4,5,6],"startsOn":"2026-01-01","endsOn":"","createdOn":"2026-01-01","time":"","active":true,"required":true,"steps":[]}],"days":{}})
}
fn replica() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    crate::init_schema(&conn).unwrap();
    conn
}
fn sidecar(conn: &Connection) -> Value {
    parse(
        crate::mvp_sync_db::read_ui(conn, KEY).unwrap().as_deref(),
        true,
    )
    .unwrap()
}
fn change(value: Value) -> Change {
    serde_json::from_value(value).unwrap()
}
fn save(conn: &mut Connection, state: &Value, intent: Option<Change>) -> Bundle {
    let old = get_bundle(conn).unwrap();
    save_bundle(
        conn,
        &state.to_string(),
        old.recurring.as_deref().unwrap_or(""),
        old.reflections.as_deref().unwrap_or(""),
        intent,
    )
    .unwrap()
}
fn setup(conn: &mut Connection) -> Value {
    let mut state = fixture_state();
    state["plans"][0]["reflection"] = json!({"prompt":"Original question"});
    save(
        conn,
        &state,
        Some(change(
            json!({"kind":"plan","id":"plan","prompt":"Original question"}),
        )),
    );
    state
}
fn answer(conn: &mut Connection, state: &mut Value) {
    let snapshot = state["plans"][0].clone();
    state["days"]["2026-01-15"] = json!({"plan":{"snapshot":snapshot,"status":"pending","reflection":{"ruleOutcome":"kept","restoration":"better","trigger":"Original answer"}}});
    save(
        conn,
        state,
        Some(change(
            json!({"kind":"answer","id":"plan","date":"2026-01-15","answer":state["days"]["2026-01-15"]["plan"]["reflection"]}),
        )),
    );
}
fn wires(conn: &Connection) -> Vec<Map<String, Value>> {
    conn.prepare("SELECT r.id,r.data,r.updated_at,v.device_id FROM mvp_records r JOIN sync_row_versions v ON v.table_name='mvp_records' AND v.row_id=r.id ORDER BY r.id").unwrap().query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"data":r.get::<_,String>(1)?,"updated_at":r.get::<_,String>(2)?,"_updated_at":r.get::<_,String>(2)?,"_device_id":r.get::<_,String>(3)?}).as_object().unwrap().clone())).unwrap().map(Result::unwrap).collect()
}
fn deliver(conn: &mut Connection, wire: &Map<String, Value>) {
    let tx = conn.transaction().unwrap();
    tx.execute("UPDATE content_sync_control SET applying=1", [])
        .unwrap();
    crate::mvp_sync_db::apply_record(&tx, wire).unwrap();
    tx.execute("UPDATE content_sync_control SET applying=0", [])
        .unwrap();
    tx.commit().unwrap();
}
fn legacy_day(state: &Value) -> Value {
    let mut state = state.clone();
    // Actual old setStatus shape (pre-3c2c929): answer is discarded.
    let snapshot = state["days"]["2026-01-15"]["plan"]["snapshot"].clone();
    state["days"]["2026-01-15"]["plan"] = json!({"snapshot":snapshot,"status":"done"});
    state["plans"][0]
        .as_object_mut()
        .unwrap()
        .remove("reflection");
    state
}

#[test]
fn canonical_prompt_and_answer_survive_legacy_status_and_plan_edits() {
    let mut conn = replica();
    let mut state = setup(&mut conn);
    answer(&mut conn, &mut state);
    let before = sidecar(&conn);
    let legacy = legacy_day(&state);
    crate::mvp_sync_db::set_ui(&conn, RECURRING, &legacy.to_string(), None).unwrap();
    let bundle = get_bundle(&mut conn).unwrap();
    assert_eq!(sidecar(&conn), before);
    // An old plan editor can replace the pending snapshot while preserving an
    // inline answer. Existing canonical data still owns the day.
    let mut stale = state.clone();
    stale["days"]["2026-01-15"]["plan"]["snapshot"]
        .as_object_mut()
        .unwrap()
        .remove("reflection");
    crate::mvp_sync_db::set_ui(&conn, RECURRING, &stale.to_string(), None).unwrap();
    get_bundle(&mut conn).unwrap();
    assert_eq!(sidecar(&conn), before);
    crate::mvp_sync_db::set_ui(&conn, RECURRING, bundle.recurring.as_ref().unwrap(), None).unwrap();
    let core: Value = serde_json::from_str(bundle.recurring.as_ref().unwrap()).unwrap();
    assert_eq!(core["days"]["2026-01-15"]["plan"]["status"], "done");
    save(&mut conn, &core, None);
    let stored = crate::mvp_sync_db::read_ui(&conn, RECURRING)
        .unwrap()
        .unwrap();
    assert!(!stored.contains("reflection"));
    assert_eq!(sidecar(&conn), before);
}

#[test]
fn late_old_outbox_three_replicas_reordered_seeds_cannot_override_authored_or_tombstones() {
    let mut a = replica();
    let mut state = setup(&mut a);
    answer(&mut a, &mut state);
    let mut b = replica();
    let mut c = replica();
    let initial = wires(&a);
    for wire in &initial {
        deliver(&mut b, wire);
    }
    let mut legacy = legacy_day(&state);
    legacy["plans"][0]["title"] = json!("Edited by old device");
    // An already-queued old payload is serialized before receiving the disable.
    crate::mvp_sync_db::set_ui(&b, RECURRING, &legacy.to_string(), None).unwrap();
    let old_outbox = wires(&b);
    let mut clean = fixture_state();
    clean["plans"][0]["reflection"] = Value::Null;
    save(
        &mut a,
        &clean,
        Some(change(json!({"kind":"plan","id":"plan","prompt":null}))),
    );
    let authored = wires(&a);
    for wire in authored.iter().rev() {
        deliver(&mut c, wire);
    }
    for wire in &old_outbox {
        deliver(&mut c, wire);
        deliver(&mut a, wire);
    }
    for wire in &authored {
        deliver(&mut b, wire);
    }
    for conn in [&mut a, &mut b, &mut c] {
        let s = sidecar(conn);
        assert_eq!(s["plans"]["plan"]["enabled"], false);
        assert_eq!(
            s["days"]["2026-01-15"]["plan"]["answer"]["trigger"],
            "Original answer"
        );
    }
    let plan_id = json!(["ui", [KEY, "plans", "plan"]]).to_string();
    let canonical = authored
        .iter()
        .find(|w| w["id"] == plan_id)
        .unwrap()
        .clone();
    let mut seed = canonical.clone();
    let mut payload: Value = serde_json::from_str(seed["data"].as_str().unwrap()).unwrap();
    payload["value"] = json!({"legacy":true,"enabled":true,"prompt":"Very late legacy seed"});
    payload["parent"] = Value::Null;
    payload["parent_writer"] = Value::Null;
    seed.insert("data".into(), json!(payload.to_string()));
    seed.insert("updated_at".into(), json!("2099-01-01T00:00:00.000Z"));
    seed.insert("_updated_at".into(), seed["updated_at"].clone());
    seed.insert("_device_id".into(), json!("legacy-seed"));
    deliver(&mut c, &seed);
    assert_eq!(sidecar(&c)["plans"]["plan"]["enabled"], false);
    let retained = wires(&c).into_iter().find(|w| w["id"] == plan_id).unwrap();
    assert_eq!(retained, canonical, "wire payload/stamp must remain exact");
    let mut fresh = replica();
    deliver(&mut fresh, &seed);
    deliver(&mut fresh, &canonical);
    assert_eq!(sidecar(&fresh)["plans"]["plan"]["enabled"], false);
    let mut tombstone = canonical.clone();
    let mut body: Value = serde_json::from_str(tombstone["data"].as_str().unwrap()).unwrap();
    body["deleted"] = json!(true);
    body["value"] = Value::Null;
    tombstone.insert("data".into(), json!(body.to_string()));
    tombstone.insert("updated_at".into(), json!("2098-01-01T00:00:00.000Z"));
    tombstone.insert("_updated_at".into(), tombstone["updated_at"].clone());
    deliver(&mut c, &tombstone);
    deliver(&mut c, &seed);
    get_bundle(&mut c).unwrap();
    assert!(sidecar(&c)["plans"].get("plan").is_none());
}

#[test]
fn migration_is_atomic_idempotent_and_keeps_historical_prompt_after_explicit_disable() {
    let mut conn = replica();
    let mut state = fixture_state();
    state["plans"][0]["reflection"] = json!({"prompt":"Old question"});
    state["days"]["2026-01-15"] = json!({"plan":{"snapshot":state["plans"][0],"status":"done","reflection":{"ruleOutcome":"broken","restoration":"worse","trigger":"Old answer"}}});
    crate::mvp_sync_db::set_ui(&conn, RECURRING, &state.to_string(), None).unwrap();
    let first = get_bundle(&mut conn).unwrap();
    let captured = wires(&conn);
    get_bundle(&mut conn).unwrap();
    initialize(&conn).unwrap();
    assert_eq!(wires(&conn), captured);
    assert!(sidecar(&conn)["plans"]["plan"]["legacy"].as_bool().unwrap());
    let mut projected: Value = serde_json::from_str(first.recurring.as_ref().unwrap()).unwrap();
    projected["plans"][0]
        .as_object_mut()
        .unwrap()
        .remove("reflection");
    save(
        &mut conn,
        &projected,
        Some(change(json!({"kind":"plan","id":"plan","prompt":null}))),
    );
    crate::mvp_sync_db::set_ui(&conn, RECURRING, &state.to_string(), None).unwrap();
    get_bundle(&mut conn).unwrap();
    assert_eq!(sidecar(&conn)["plans"]["plan"]["enabled"], false);
    assert_eq!(
        sidecar(&conn)["days"]["2026-01-15"]["plan"]["prompt"],
        "Old question"
    );
    assert_eq!(
        sidecar(&conn)["days"]["2026-01-15"]["plan"]["answer"]["trigger"],
        "Old answer"
    );
    let mut broken = replica();
    crate::mvp_sync_db::set_ui(&broken, RECURRING, &state.to_string(), None).unwrap();
    broken.execute_batch("CREATE TRIGGER fail_sidecar BEFORE INSERT ON mvp_records WHEN NEW.id LIKE '%calendar_reflections_v1%days%' BEGIN SELECT RAISE(ABORT,'synthetic'); END;").unwrap();
    assert!(get_bundle(&mut broken).is_err());
    assert!(crate::mvp_sync_db::read_ui(&broken, KEY).unwrap().is_none());
    assert!(wires(&broken)
        .iter()
        .all(|w| !w["id"].as_str().unwrap().contains(KEY)));
}

#[test]
fn bundle_cas_and_failure_roll_back_both_states_and_journal() {
    let mut conn = replica();
    let mut state = setup(&mut conn);
    let before = get_bundle(&mut conn).unwrap();
    let before_rows = wires(&conn);
    let wrong = save_bundle(
        &mut conn,
        &state.to_string(),
        before.recurring.as_deref().unwrap(),
        "stale",
        Some(change(json!({"kind":"plan","id":"plan","prompt":null}))),
    )
    .unwrap_err();
    assert_eq!(wrong, "mvp_sync_stale_ui_state");
    assert_eq!(wires(&conn), before_rows);
    conn.execute_batch("CREATE TRIGGER fail_core BEFORE UPDATE ON ui_state WHEN NEW.key='calendar_recurring_v1' BEGIN SELECT RAISE(ABORT,'synthetic'); END;").unwrap();
    state["plans"][0]["title"] = json!("Changed");
    assert!(save_bundle(
        &mut conn,
        &state.to_string(),
        before.recurring.as_deref().unwrap(),
        before.reflections.as_deref().unwrap(),
        Some(change(
            json!({"kind":"plan","id":"plan","prompt":"New question"})
        ))
    )
    .is_err());
    assert_eq!(wires(&conn), before_rows);
    assert_eq!(
        get_bundle(&mut conn).unwrap().reflections,
        before.reflections
    );
    assert_eq!(
        crate::mvp_sync_db::set_ui(&conn, KEY, "{}", None).unwrap_err(),
        "reflection_use_bundle_command"
    );
}

#[test]
fn native_validation_rejects_invalid_intent_and_forged_history_without_writes() {
    let mut conn = replica();
    let state = setup(&mut conn);
    let before = get_bundle(&mut conn).unwrap();
    let before_rows = wires(&conn);
    for bad in [
        json!({"kind":"plan","id":"","prompt":"x"}),
        json!({"kind":"plan","id":"plan","prompt":"x".repeat(161)}),
        json!({"kind":"answer","id":"plan","date":"2099-01-01","answer":{"ruleOutcome":"kept","restoration":"better","trigger":""}}),
        json!({"kind":"answer","id":"plan","date":"2026-01-15","answer":{"ruleOutcome":"invalid","restoration":"better","trigger":""}}),
    ] {
        assert!(save_bundle(
            &mut conn,
            &state.to_string(),
            before.recurring.as_deref().unwrap(),
            before.reflections.as_deref().unwrap(),
            Some(change(bad))
        )
        .is_err());
    }
    let mut forged = state.clone();
    forged["days"]["2026-01-15"] = json!({"plan":{"snapshot":state["plans"][0],"status":"done"}});
    forged["days"]["2026-01-15"]["plan"]["snapshot"]["title"] = json!("Forged title");
    assert!(save_bundle(&mut conn,&forged.to_string(),before.recurring.as_deref().unwrap(),before.reflections.as_deref().unwrap(),Some(change(json!({"kind":"answer","id":"plan","date":"2026-01-15","answer":{"ruleOutcome":"kept","restoration":"better","trigger":""}})))).is_err());
    assert_eq!(wires(&conn), before_rows);
    assert!(serde_json::from_value::<Change>(json!({"kind":"answer","id":"plan","date":"2026-01-15","answer":{"ruleOutcome":"kept","restoration":"better","secret":"unexpected"}})).is_err());
}

#[test]
fn bundle_commands_cross_native_ipc_and_reject_stale_second_key() {
    use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
    use tauri::Manager;
    let app = mock_builder()
        .manage(crate::AppState(std::sync::Mutex::new(replica())))
        .invoke_handler(tauri::generate_handler![
            recurring_get_bundle,
            recurring_save_bundle
        ])
        .build(mock_context(noop_assets()))
        .unwrap();
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let call = |name: &str, body: Value| -> Result<Value, Value> {
        get_ipc_response(
            &webview,
            tauri::webview::InvokeRequest {
                cmd: name.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: if cfg!(windows) {
                    "http://tauri.localhost"
                } else {
                    "tauri://localhost"
                }
                .parse()
                .unwrap(),
                body: tauri::ipc::InvokeBody::Json(body),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.into(),
            },
        )
        .map(|v| v.deserialize::<Value>().unwrap())
    };
    let first = call("recurring_get_bundle", json!({})).unwrap();
    assert!(first["recurring"].is_null());
    assert!(first["reflections"].is_null());
    let mut state = fixture_state();
    state["plans"][0]["reflection"] = json!({"prompt":"Question"});
    let saved=call("recurring_save_bundle",json!({"value":state.to_string(),"expectedRecurring":"","expectedReflections":"","reflectionChange":{"kind":"plan","id":"plan","prompt":"Question"}})).unwrap();
    assert!(!saved["recurring"].as_str().unwrap().contains("reflection"));
    let reflection: Value = serde_json::from_str(saved["reflections"].as_str().unwrap()).unwrap();
    assert_eq!(reflection["plans"]["plan"]["prompt"], "Question");
    let rejected=call("recurring_save_bundle",json!({"value":state.to_string(),"expectedRecurring":saved["recurring"],"expectedReflections":"","reflectionChange":{"kind":"plan","id":"plan","prompt":null}})).unwrap_err();
    assert_eq!(rejected, "mvp_sync_stale_ui_state");
    assert_eq!(call("recurring_get_bundle", json!({})).unwrap(), saved);
    assert!(call("recurring_save_bundle",json!({"value":state.to_string(),"expectedRecurring":saved["recurring"],"expectedReflections":saved["reflections"],"reflectionChange":{"kind":"plan","id":"plan"}})).is_err());
    let app_state = app.state::<crate::AppState>();
    let conn = app_state.0.lock().unwrap();
    assert_eq!(sidecar(&conn)["plans"]["plan"]["prompt"], "Question");
}

#[test]
fn answered_migration_seed_dominates_later_empty_seed_in_both_orders() {
    let mut source = replica();
    let mut legacy = fixture_state();
    legacy["plans"][0]["reflection"] = json!({"prompt":"Migrated question"});
    legacy["days"]["2026-01-15"] = json!({"plan":{"snapshot":legacy["plans"][0],"status":"done","reflection":{"ruleOutcome":"broken","restoration":"same","trigger":"Migrated answer"}}});
    crate::mvp_sync_db::set_ui(&source, RECURRING, &legacy.to_string(), None).unwrap();
    get_bundle(&mut source).unwrap();
    let id = json!(["ui", [KEY, "days", "2026-01-15", "plan"]]).to_string();
    let answered = wires(&source).into_iter().find(|w| w["id"] == id).unwrap();
    let mut empty = answered.clone();
    let mut payload: Value = serde_json::from_str(empty["data"].as_str().unwrap()).unwrap();
    payload["value"]["answer"] = Value::Null;
    empty.insert("data".into(), json!(payload.to_string()));
    empty.insert("updated_at".into(), json!("2099-01-01T00:00:00.000Z"));
    empty.insert("_updated_at".into(), empty["updated_at"].clone());
    empty.insert("_device_id".into(), json!("empty-seed"));
    for order in [[&answered, &empty], [&empty, &answered]] {
        let mut peer = replica();
        for wire in order {
            deliver(&mut peer, wire);
        }
        assert_eq!(
            wires(&peer).into_iter().find(|w| w["id"] == id).unwrap(),
            answered
        );
        assert_eq!(
            sidecar(&peer)["days"]["2026-01-15"]["plan"]["answer"]["trigger"],
            "Migrated answer"
        );
    }
}

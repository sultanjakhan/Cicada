//! macOS ingress for exactly the seven portable personal-task tools.
use crate::agent_socket_transport::{self as transport, Endpoint};
use serde_json::{json, Value};
use std::{path::Path, time::Duration};
use tauri::{Emitter, Manager};

fn allowed(request: &crate::agent_access::Request) -> bool {
    matches!(request.action.as_str(), "list" | "get" | "begin" | "report") ||
        (request.action == "task-command" &&
            request.body["command"].as_str().is_some_and(|c| ["get", "operation", "submit_result"].contains(&c)))
}
fn checked_request(bytes: &[u8]) -> Result<crate::agent_access::Request, String> {
    let request = crate::agent_access::parse(bytes)?;
    if !allowed(&request) { return Err("agent_request_rejected".into()) }
    Ok(request)
}
fn execute(app: tauri::AppHandle, bytes: Vec<u8>) -> Result<Value, String> {
    let request = checked_request(&bytes)?;
    let changed = matches!(request.action.as_str(), "begin" | "report") ||
        (request.action == "task-command" && request.body["command"] == "submit_result");
    let state = app.state::<crate::AppState>();
    let mut connection = state.0.lock().map_err(|_| "agent_database_busy".to_string())?;
    let result = crate::agent_access::execute(&mut connection, request)?;
    drop(connection);
    if changed { let _ = app.emit("mvp-sync-updated", json!({"views_changed":true})); }
    Ok(result)
}
pub(crate) fn start(app: tauri::AppHandle, endpoint_root: &Path) -> Result<(), String> {
    let profile = crate::data_location::stable_endpoint_dir(endpoint_root).map_err(|_| "agent_socket_profile")?;
    let Some(directory) = transport::configured_directory(&profile)? else { return Ok(()) };
    let endpoint = tauri::async_runtime::block_on(Endpoint::bind(&directory, &profile))?;
    tauri::async_runtime::spawn(async move {
        loop {
            let mut stream = match endpoint.accept().await {
                Ok(stream) => stream,
                Err(error) if error == "agent_socket_peer_rejected" => continue,
                Err(_) => break,
            };
            let reply = match transport::read_frame(&mut stream, transport::FRAME_LIMIT, Duration::from_secs(3)).await {
                Err(error) => json!({"ok":false,"error":error}),
                Ok(bytes) => {
                    let handle = app.clone();
                    // A timed-out blocking call may still commit. Preserve operation
                    // IDs and recover through receipts; never claim cancellation.
                    let result = tokio::time::timeout(Duration::from_secs(30),
                        tauri::async_runtime::spawn_blocking(move || execute(handle, bytes))).await;
                    match result {
                        Ok(Ok(Ok(value))) => json!({"ok":true,"result":value}),
                        Ok(Ok(Err(error))) => json!({"ok":false,"error":error}),
                        _ => json!({"ok":false,"error":"agent_outcome_unknown"}),
                    }
                }
            };
            let raw = reply.to_string().into_bytes();
            if raw.len() + 1 <= transport::REPLY_LIMIT {
                let _ = transport::write_frame(&mut stream, &raw).await;
            } else {
                let _ = transport::write_frame(&mut stream, br#"{"ok":false,"error":"agent_response_too_large"}"#).await;
            }
        }
    });
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn request(action: &str, command: &str) -> crate::agent_access::Request {
        crate::agent_access::Request {version:1,operation_id:"synthetic-op-001".into(),action:action.into(),
            body:json!({"command":command,"arguments":{}})}
    }
    #[test]
    fn ingress_exposes_only_existing_seven_tool_actions() {
        for action in ["list","get","begin","report"] { assert!(allowed(&request(action, ""))); }
        for command in ["get","operation","submit_result"] { assert!(allowed(&request("task-command", command))); }
        for command in ["snapshot","create","share","patch","comment","review","acknowledge","archive"] {
            assert!(!allowed(&request("task-command", command)));
        }
        for action in ["invoke","shell","review","sync","settings"] { assert!(!allowed(&request(action, ""))); }
    }
    #[tokio::test]
    async fn existing_native_task_linkage_and_receipts_survive_the_socket() {
        use std::{fs, os::unix::fs::PermissionsExt, sync::{Arc, Mutex}};
        use tokio::net::UnixStream;
        let root = tempfile::Builder::new().prefix("cai-").tempdir_in("/private/tmp").unwrap();
        let physical = root.path().canonicalize().unwrap();
        let profile = physical.join("p"); let sockets = physical.join("s");
        fs::create_dir(&profile).unwrap(); fs::create_dir(&sockets).unwrap();
        fs::set_permissions(&profile, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(&sockets, fs::Permissions::from_mode(0o700)).unwrap();
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        crate::init_schema(&connection).unwrap();
        let id = crate::calendar_compat::create_note_in_transaction(&connection, "Synthetic existing personal task",
            "Synthetic only", "task-sphere:personal", "task", &None, None).unwrap().id;
        let work = crate::calendar_compat::create_note_in_transaction(&connection, "Synthetic work task",
            "Synthetic only", "task-sphere:work", "task", &None, None).unwrap().id;
        let database = Arc::new(Mutex::new(connection));
        let endpoint = Endpoint::bind(&sockets, &profile).await.unwrap();
        let path = transport::endpoint(&sockets, &profile).unwrap();
        let shared = database.clone();
        let server = tokio::spawn(async move {
            for _ in 0..10 {
                let mut stream = endpoint.accept().await.unwrap();
                let raw = transport::read_frame(&mut stream, transport::FRAME_LIMIT, Duration::from_secs(1)).await.unwrap();
                let result = checked_request(&raw).and_then(|request|
                    crate::agent_access::execute(&mut shared.lock().unwrap(), request));
                let reply = match result { Ok(value) => json!({"ok":true,"result":value}), Err(error) => json!({"ok":false,"error":error}) };
                transport::write_frame(&mut stream, reply.to_string().as_bytes()).await.unwrap();
            }
        });
        async fn call(path: &Path, operation: &str, action: &str, body: Value) -> Value {
            let mut stream = UnixStream::connect(path).await.unwrap();
            let raw = json!({"version":1,"operation_id":operation,"action":action,"body":body}).to_string();
            transport::write_frame(&mut stream, raw.as_bytes()).await.unwrap();
            let reply = transport::read_frame(&mut stream, transport::REPLY_LIMIT, Duration::from_secs(1)).await.unwrap();
            serde_json::from_slice(&reply).unwrap()
        }
        let report = |status: &str, sequence: u64| json!({"runId":"synthetic-socket-run","sequence":sequence,
            "taskKey":null,"agent":"codex","model":null,"provider":null,"stage":null,"status":status,
            "skillIds":[],"mcpCalls":null,"inputTokens":null,"outputTokens":null});
        assert_eq!(call(&path,"socket-read-001","get",json!({"taskId":id})).await["result"]["id"], id);
        assert_eq!(call(&path,"socket-work-001","get",json!({"taskId":work})).await["error"], "personal_task_required");
        let begin = json!({"title":"Synthetic existing personal task","content":"Synthetic only","taskId":id,
            "expectedVersion":1,"projects":[],"report":report("running",1)});
        let mut stale = begin.clone(); stale["expectedVersion"] = json!(2);
        assert_eq!(call(&path,"socket-stale-001","begin",stale).await["error"], "task_version_conflict");
        let first = call(&path,"socket-begin-001","begin",begin.clone()).await;
        assert_eq!(first["ok"], true); assert_eq!(first["result"]["task"]["id"], id);
        assert_eq!(call(&path,"socket-begin-001","begin",begin).await, first);
        assert_eq!(call(&path,"socket-seq-001","report",json!({"taskId":id,"expectedVersion":1,"report":report("done",1)})).await["error"],
            "run_sequence_or_identity_conflict");
        let done = json!({"taskId":id,"expectedVersion":1,"report":report("done",2)});
        assert_eq!(call(&path,"socket-done-001","report",done.clone()).await["ok"], true);
        let mut conflict = done; conflict["report"]["sequence"] = json!(3);
        assert_eq!(call(&path,"socket-done-001","report",conflict).await["error"], "operation_payload_conflict");
        assert_eq!(call(&path,"socket-denied-001","task-command",json!({"command":"review","arguments":{}})).await["error"], "agent_request_rejected");
        assert_eq!(call(&path,"socket-final-001","get",json!({"taskId":id})).await["result"]["completed"], false);
        server.await.unwrap();
        let connection = database.lock().unwrap();
        assert_eq!(connection.query_row("SELECT count(*) FROM items",[],|r|r.get::<_,i64>(0)).unwrap(),2);
        assert_eq!(connection.query_row("SELECT count(*) FROM timeline_blocks",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        assert_eq!(crate::agent_access::exchange(&connection).unwrap()["runs"]["synthetic-socket-run"]["report"]["status"],"done");
    }

}

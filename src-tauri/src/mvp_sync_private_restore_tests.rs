use super::*;
use super::super::{checkpoint, initialize};

fn cfg(device: &str) -> RelayConfig {
    RelayConfig {v:1,profile:super::super::super::PROFILE.into(),endpoint:"https://example.invalid/".into(),
        device_id:device.into(),key_id:"synthetic-key".into(),token:B64.encode([1;32]),key:B64.encode([2;32]),enabled:false}
}
fn task(c: &Connection, id: &str) {
    c.execute("INSERT INTO items(id,kind,title,duration_minutes,version,created_at,updated_at,tags) VALUES(?1,'task','Synthetic task',30,1,'2026-10-18T00:00:00Z','2026-10-18T00:00:00Z','task-sphere:personal')",[id]).unwrap();
}
fn source() -> Connection {
    let c = Connection::open_in_memory().unwrap();
    crate::init_schema(&c).unwrap();
    task(&c,"pc-task");
    task(&c,"pc-completed");
    c.execute("UPDATE items SET completed=1,status='done',version=2 WHERE id='pc-completed'",[]).unwrap();
    c.execute("INSERT INTO calendar_goals(id,title,created_at,updated_at) VALUES('pc-goal','Synthetic goal','2026-10-18T00:00:00Z','2026-10-18T00:00:00Z')",[]).unwrap();
    c.execute("INSERT INTO calendar_task_goals VALUES('note','pc-task','pc-goal','2026-10-18T00:00:00Z')",[]).unwrap();
    db::set_ui(&c,db::DAY_KEY,&json!({"version":1,"entries":[{"id":"pc-day","started_at_utc":"2026-10-18T16:07:51.695Z"}]}).to_string(),None).unwrap();
    c
}
fn mac() -> (tempfile::TempDir,std::path::PathBuf,Connection,RelayConfig) {
    let dir = tempfile::tempdir().unwrap();
    std::fs::set_permissions(dir.path(),std::fs::Permissions::from_mode(0o700)).unwrap();
    let database = dir.path().canonicalize().unwrap().join("calendar.db");
    let mut c = Connection::open(&database).unwrap();
    crate::init_schema(&c).unwrap();
    let config = cfg("synthetic-mac");
    initialize(&mut c,&derive_config(&config).unwrap()).unwrap();
    c.execute("INSERT INTO app_settings VALUES('content_sync_enabled','false','created')",[]).unwrap();
    super::super::super::private_file::install(&database,&serde_json::to_string(&config).unwrap()).unwrap();
    c.execute_batch("INSERT INTO content_sync_outbox(local_seq,batch_id,body,envelope_hash) VALUES(8,'synthetic','{}','synthetic');DELETE FROM content_sync_outbox;UPDATE content_sync_state SET receive_seq=10;INSERT INTO content_sync_sender_watermarks VALUES('synthetic-mac',8,8);INSERT INTO content_sync_receipts VALUES('old-peer',5);DELETE FROM content_sync_dirty;").unwrap();
    for index in 0..118 { task(&c,&format!("old-{index:03}")); }
    db::set_ui(&c,db::DAY_KEY,&json!({"version":1,"entries":[{"id":"old-day","started_at_utc":"2026-10-02T00:00:00Z"}]}).to_string(),None).unwrap();
    c.execute("INSERT INTO timeline_blocks(id,source_type,source_id,date,start_time,created_at,updated_at) VALUES(1,'note','old-000','2026-10-02','09:00','created','created')",[]).unwrap();
    db::set_ui(&c,"calendar_now_v1","{\"version\":1,\"entry\":null}",None).unwrap();
    c.execute("INSERT INTO ui_state VALUES('calendar_preferences_v1','{\"local\":true}','created')",[]).unwrap();
    crate::agent_history::ensure(&c).unwrap();
    c.execute_batch("CREATE TABLE local_review_audit(seq INTEGER PRIMARY KEY,task_id TEXT,operation_id TEXT,body TEXT);INSERT INTO local_review_audit VALUES(1,'old-000','local-operation','local-audit');CREATE TABLE local_review_state(task_id TEXT PRIMARY KEY,result_version INTEGER,state TEXT,intent_id TEXT);INSERT INTO local_review_state VALUES('old-000',1,'accepted',NULL);CREATE TABLE local_review_results(task_id TEXT,result_version INTEGER,content TEXT,published_task_version INTEGER);INSERT INTO local_review_results VALUES('old-000',1,'local-result',1);UPDATE items SET completed=1,status='done' WHERE id='old-000';").unwrap();
    assert_eq!(scalar(&c,"SELECT count(*) FROM content_sync_dirty").unwrap(),121);
    (dir,database,c,config)
}
fn signed(c: &Connection, source: &Connection, config: &RelayConfig) -> Input {
    let mut q = source.prepare("SELECT id FROM mvp_records ORDER BY id").unwrap();
    let records = q.query_map([],|r| r.get::<_,String>(0)).unwrap().map(|id| {
        let row = checkpoint::snapshot_row(source,"mvp_records",&id.unwrap(),"synthetic-pc").unwrap();
        serde_json::from_value::<WireRecord>(Value::Object(row.f)).unwrap()
    }).collect();
    let snapshot = Snapshot {records,watermarks:vec![
        Watermark {device_id:"synthetic-mac".into(),client_seq:8,server_seq:8},
        Watermark {device_id:"synthetic-pc".into(),client_seq:2,server_seq:100}]};
    let bytes = serde_json::to_vec(&snapshot).unwrap();
    let mut input = Input {v:1,schema:DOMAIN.into(),operation_id:"00000000-0000-4000-8000-000000000001".into(),
        metadata: Metadata {profile:config.profile.clone(),endpoint:config.endpoint.trim_end_matches('/').into(),key_id:config.key_id.clone(),
            target_device_id:config.device_id.clone(),target_scope:c.query_row("SELECT scope FROM content_sync_state",[],|r| r.get(0)).unwrap(),
            source_device_id:"synthetic-pc".into(),schema_version:crate::SCHEMA_VERSION,captured_at_utc:"2026-10-18T17:00:00.000Z".into(),receive_seq:100,
            payload_bytes:bytes.len(),payload_sha256:hash(&bytes),tasks_semantic_sha256:task_digest(source).unwrap()},
        payload_base64url:B64.encode(&bytes),hmac:String::new()};
    resign(&mut input,config);
    input
}
fn resign(input: &mut Input, config: &RelayConfig) {
    let mut mac = <HmacSha256 as Mac>::new_from_slice(&signing_key(config).unwrap()).unwrap();
    mac.update(&canonical(input).unwrap());input.hmac=hex::encode(mac.finalize().into_bytes());
}
fn write_input(database: &Path, input: &Input) -> std::path::PathBuf {
    let p = database.parent().unwrap().join("snapshot.json");
    std::fs::write(&p,serde_json::to_vec(input).unwrap()).unwrap();
    std::fs::set_permissions(&p,std::fs::Permissions::from_mode(0o600)).unwrap();p
}
fn unchanged(c: &Connection) -> Value {
    json!({"tasks":task_digest(c).unwrap(),"cursor":scalar(c,"SELECT receive_seq FROM content_sync_state").unwrap(),
        "dirty":scalar(c,"SELECT count(*) FROM content_sync_dirty").unwrap(),"sequence":scalar(c,"SELECT seq FROM sqlite_sequence WHERE name='content_sync_outbox'").unwrap(),
        "receipt":db::get_setting_checked(c,RECEIPT).unwrap(),"enabled":db::get_setting_checked(c,"content_sync_enabled").unwrap(),
        "day":db::day_ledger(c).unwrap(),"namespace":crate::agent_history::load(c).unwrap()["sourceNamespace"]})
}
#[test]
fn python_contract_hmac_vector_matches() {
    let config=cfg("synthetic-mac");let c=Connection::open_in_memory().unwrap();crate::init_schema(&c).unwrap();
    c.execute_batch("CREATE TABLE content_sync_state(scope TEXT);INSERT INTO content_sync_state VALUES('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');").unwrap();
    let mut input=signed(&c,&source(),&config);
    let snapshot=Snapshot {records:vec![],watermarks:vec![Watermark {device_id:"synthetic-mac".into(),client_seq:8,server_seq:8},Watermark {device_id:"synthetic-pc".into(),client_seq:1,server_seq:100}]};
    let bytes=serde_json::to_vec(&snapshot).unwrap();input.metadata.payload_bytes=bytes.len();input.metadata.payload_sha256=hash(&bytes);input.metadata.tasks_semantic_sha256=hash(b"[]");input.payload_base64url=B64.encode(bytes);resign(&mut input,&config);
    assert_eq!(input.hmac,"e3cddea748dadeae8ef01af9df520cb61f1f6191afa238372e12b8d946779ca6");
}
#[test]
fn restores_pc_content_preserves_mac_identity_and_never_enqueues_old_dirty() {
    let (_dir,path,mut c,config)=mac();let source=source();let input=signed(&c,&source,&config);let file=write_input(&path,&input);
    let identity=db::get_setting_checked(&c,"device_id").unwrap();let namespace=crate::agent_history::load(&c).unwrap()["sourceNamespace"].clone();
    let receipt=restore(&mut c,&path,&file).unwrap();
    assert_eq!(task_digest(&c).unwrap(),task_digest(&source).unwrap());assert_eq!(db::day_ledger(&c).unwrap(),db::day_ledger(&source).unwrap());
    assert_eq!(db::get_setting_checked(&c,"device_id").unwrap(),identity);assert_eq!(crate::agent_history::load(&c).unwrap()["sourceNamespace"],namespace);
    assert_eq!(scalar(&c,"SELECT seq FROM sqlite_sequence WHERE name='content_sync_outbox'").unwrap(),8);
    assert_eq!(c.query_row("SELECT value FROM ui_state WHERE key='calendar_preferences_v1'",[],|r| r.get::<_,String>(0)).unwrap(),"{\"local\":true}");
    assert_eq!(c.query_row("SELECT body FROM local_review_audit",[],|r| r.get::<_,String>(0)).unwrap(),"local-audit");
    assert_eq!(c.query_row("SELECT content FROM local_review_results",[],|r| r.get::<_,String>(0)).unwrap(),"local-result");
    assert_eq!(scalar(&c,"SELECT applied_seq FROM content_sync_receipts WHERE device_id='old-peer'").unwrap(),5);
    assert_eq!(scalar(&c,"SELECT count(*) FROM content_sync_dirty").unwrap(),0);assert_eq!(receipt["network_started"],false);
    let backup=Connection::open_with_flags(receipt["backup"].as_str().unwrap(),rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    assert_eq!(scalar(&backup,"SELECT count(*) FROM content_sync_dirty").unwrap(),121);
    assert_eq!(scalar(&backup,"SELECT count(*) FROM items WHERE kind='task'").unwrap(),118);
    let derived=derive_config(&config).unwrap();assert!(enqueue(&mut c,&derived).unwrap());
    let raw:String=c.query_row("SELECT body FROM content_sync_outbox",[],|r|r.get(0)).unwrap();let batch:Batch=serde_json::from_str(&raw).unwrap();
    assert_eq!(batch.client_seq,9);let payload=unseal(&derived,&derived.device_id,&batch).unwrap();
    assert_eq!(payload.kind,"receipt");assert!(payload.rows.is_empty()&&payload.tombs.is_empty());
}
#[test]
fn rejects_signature_scope_and_outbox_without_changing_business_or_positions() {
    for case in ["signature","scope","outbox","enabled","sequence","local-review"] {
        let (_dir,path,mut c,config)=mac();let mut input=signed(&c,&source(),&config);
        match case {
            "signature"=>input.hmac="0".repeat(64),
            "scope"=>{input.metadata.target_scope="b".repeat(64);resign(&mut input,&config);},
            "outbox"=>{c.execute("INSERT INTO content_sync_outbox VALUES(9,'pending','{}','synthetic')",[]).unwrap();},
            "enabled"=>{c.execute("UPDATE app_settings SET value='true' WHERE key='content_sync_enabled'",[]).unwrap();},
            "sequence"=>{c.execute("UPDATE sqlite_sequence SET seq=9 WHERE name='content_sync_outbox'",[]).unwrap();},
            "local-review"=>{c.execute("INSERT INTO local_review_state VALUES('pc-task',1,'accepted',NULL)",[]).unwrap();},
            _=>unreachable!()
        }
        let before=unchanged(&c);let file=write_input(&path,&input);assert!(restore(&mut c,&path,&file).is_err(),"{case}");assert_eq!(unchanged(&c),before,"{case}");
    }
}
#[test]
fn invalid_dependency_is_rolled_back_and_replay_does_not_replace_later_work() {
    let (_dir,path,mut c,config)=mac();let mut input=signed(&c,&source(),&config);
    let mut snapshot:Snapshot=serde_json::from_slice(&B64.decode(&input.payload_base64url).unwrap()).unwrap();
    snapshot.records.retain(|r| !r.id.contains("calendar_goals"));let bytes=serde_json::to_vec(&snapshot).unwrap();
    input.metadata.payload_bytes=bytes.len();input.metadata.payload_sha256=hash(&bytes);input.payload_base64url=B64.encode(bytes);resign(&mut input,&config);
    let before=unchanged(&c);let file=write_input(&path,&input);assert_eq!(restore(&mut c,&path,&file).unwrap_err(),"mvp_sync_private_restore_dependency_failed");assert_eq!(unchanged(&c),before);
    let fields=field_maps(&snapshot).unwrap();assert!(replace(&mut c,&input,&snapshot,&fields,&config,&json!({})).is_err());assert_eq!(unchanged(&c),before,"the actual replacement transaction also rolls back");
    let valid=signed(&c,&source(),&config);let file=write_input(&path,&valid);let receipt=restore(&mut c,&path,&file).unwrap();task(&c,"later-local-task");
    let before=unchanged(&c);assert_eq!(restore(&mut c,&path,&file).unwrap(),receipt);assert_eq!(unchanged(&c),before);
}

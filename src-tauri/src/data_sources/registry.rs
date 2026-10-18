//! Exact, ephemeral user-selected snapshot capability. No caller-supplied paths.
use std::{collections::HashMap,fs::{File,OpenOptions},io::Read,path::{Component,Path,PathBuf},sync::{Mutex,OnceLock},time::{Duration,Instant,SystemTime}};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest,Sha256};
use crate::AppState;
const MAX_BYTES:u64=1024*1024;
const REGISTRY:&str="engineering_work_registry_v1";
const SOURCES:&str="cicada_data_sources_v1";
#[derive(Clone,PartialEq,Eq)]
struct Fingerprint {len:u64,modified:SystemTime,identity:(u64,u64)}
fn fingerprint(file:&File)->Result<Fingerprint,String>{
 let m=file.metadata().map_err(|_|"source_read_denied")?;
 if !m.is_file()||m.len()>MAX_BYTES{return Err("source_file_bounds".into());}
 #[cfg(unix)] let identity={use std::os::unix::fs::MetadataExt;(m.dev(),m.ino())};
 #[cfg(windows)] let identity={use std::os::windows::io::AsRawHandle;use windows::Win32::{Foundation::HANDLE,Storage::FileSystem::{GetFileInformationByHandle,BY_HANDLE_FILE_INFORMATION}};let mut i=BY_HANDLE_FILE_INFORMATION::default();unsafe{GetFileInformationByHandle(HANDLE(file.as_raw_handle()),&mut i)}.map_err(|_|"source_identity_unavailable")?;(i.dwVolumeSerialNumber as u64,((i.nFileIndexHigh as u64)<<32)|i.nFileIndexLow as u64)};
 #[cfg(not(any(unix,windows)))] let identity=(0,0);
 Ok(Fingerprint{len:m.len(),modified:m.modified().map_err(|_|"source_identity_unavailable")?,identity})
}
fn safe_open(path:&Path)->Result<File,String>{
 let raw=path.to_string_lossy();
 if !path.is_absolute()||raw.len()>1024||raw.chars().any(char::is_control)||path.extension().and_then(|e|e.to_str()).is_none_or(|e|!e.eq_ignore_ascii_case("json")){return Err("invalid_selected_source".into());}
 #[cfg(windows)] if raw.starts_with(r"\\"){return Err("source_remote_path_not_allowed".into());}
 let check=||->Result<(),String>{let mut prefix=PathBuf::new();for c in path.components(){if matches!(c,Component::ParentDir|Component::CurDir){return Err("invalid_selected_source".into());}prefix.push(c.as_os_str());if matches!(c,Component::Normal(_)){super::ordinary(&prefix)?;}}Ok(())};
 check()?;
 if !std::fs::symlink_metadata(path).map_err(|_|"source_read_denied")?.is_file(){return Err("source_regular_file_required".into());}
 let mut options=OpenOptions::new();options.read(true);
 #[cfg(target_os="linux")] {use std::os::unix::fs::OpenOptionsExt;options.custom_flags(0x800|0x20000);}// O_NONBLOCK | O_NOFOLLOW
 #[cfg(windows)] {use std::os::windows::fs::OpenOptionsExt;use windows::Win32::Storage::FileSystem::{FILE_FLAG_OPEN_REPARSE_POINT,FILE_SHARE_READ};options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT.0).share_mode(FILE_SHARE_READ.0);}
 let file=options.open(path).map_err(|_|"source_read_denied")?;check()?;
 // A replacement between path validation and open must not redirect this grant.
 let expected=fingerprint(&file)?;let current=options.open(path).map_err(|_|"source_read_denied")?;check()?;
 if expected!=fingerprint(&current)?{return Err("source_selection_changed".into());}
 Ok(file)
}
struct Grant {owner:String,path:PathBuf,identity:Fingerprint,created:Instant}
#[derive(Default)]
pub(crate) struct Grants {entries:HashMap<String,Grant>}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct Selection {grant_id:String,file_name:String}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct SnapshotRead {grant_id:String,digest:String,raw:String,read_at:String}
impl Grants {
 fn select(&mut self,owner:&str,path:&Path)->Result<Selection,String>{
  let file=safe_open(path)?;let identity=fingerprint(&file)?;let grant_id=uuid::Uuid::new_v4().to_string();
  self.entries.retain(|_,g|g.owner!=owner&&g.created.elapsed()<Duration::from_secs(600));
  self.entries.insert(grant_id.clone(),Grant{owner:owner.into(),path:path.into(),identity,created:Instant::now()});
  Ok(Selection{grant_id,file_name:path.file_name().and_then(|s|s.to_str()).unwrap_or("snapshot.json").to_owned()})
 }
 fn read(&mut self,owner:&str,id:&str,expected:Option<&str>)->Result<SnapshotRead,String>{
  let result:Result<SnapshotRead,String>=(||{
   let g=self.entries.get(id).filter(|g|g.owner==owner&&g.created.elapsed()<Duration::from_secs(600)).ok_or("source_grant_unavailable")?;
   let mut file=safe_open(&g.path)?;if fingerprint(&file)?!=g.identity{return Err("source_selection_changed".into());}
   let mut bytes=Vec::new();(&mut file).take(MAX_BYTES+1).read_to_end(&mut bytes).map_err(|_|"source_read_denied")?;
   if bytes.len() as u64>MAX_BYTES||fingerprint(&file)?!=g.identity||fingerprint(&safe_open(&g.path)?)?!=g.identity{return Err("source_selection_changed".into());}
   let digest=format!("{:x}",Sha256::digest(&bytes));if expected.is_some_and(|s|s!=digest){return Err("source_content_changed".into());}
   let raw=String::from_utf8(bytes).map_err(|_|"source_utf8_required")?;
   let value:Value=serde_json::from_str(&raw).map_err(|_|"source_json_required")?;
   if value["schemaVersion"]!=1||value["kind"]!="work-registry-snapshot"||value["tasks"].as_array().is_none_or(|v|v.len()>1000)||value["projects"].as_array().is_none_or(|v|v.len()>100){return Err("source_snapshot_bounds".into());}
   Ok(SnapshotRead{grant_id:id.into(),digest,raw,read_at:chrono::Utc::now().to_rfc3339()})
  })();
  if result.is_err()&&self.entries.get(id).is_some_and(|g|g.owner==owner){self.entries.remove(id);}
  result
 }
 fn revoke(&mut self,owner:&str,id:&str){if self.entries.get(id).is_some_and(|g|g.owner==owner){self.entries.remove(id);}}
}
static GRANTS:OnceLock<Mutex<Grants>>=OnceLock::new();
fn grants()->&'static Mutex<Grants>{GRANTS.get_or_init(||Mutex::new(Grants::default()))}
#[tauri::command]
pub fn choose_registry_source(window:tauri::WebviewWindow)->Result<Option<Selection>,String>{
 #[cfg(windows)] {
  use windows::{core::{w,PCWSTR},Win32::{System::Com::{CoCreateInstance,CoInitializeEx,CoTaskMemFree,CoUninitialize,CLSCTX_INPROC_SERVER,COINIT_APARTMENTTHREADED},UI::Shell::{IFileOpenDialog,FileOpenDialog,FOS_FILEMUSTEXIST,FOS_PATHMUSTEXIST,FOS_FORCEFILESYSTEM,FOS_DONTADDTORECENT,FOS_NOCHANGEDIR,SIGDN_FILESYSPATH,Common::COMDLG_FILTERSPEC}}};
  unsafe {
   CoInitializeEx(None,COINIT_APARTMENTTHREADED).ok().map_err(|_|"source_chooser_unavailable")?;
   struct ComGuard;impl Drop for ComGuard{fn drop(&mut self){unsafe{CoUninitialize()}}}let _com=ComGuard;
   let dialog:IFileOpenDialog=CoCreateInstance(&FileOpenDialog,None,CLSCTX_INPROC_SERVER).map_err(|_|"source_chooser_unavailable")?;
   dialog.SetOptions(FOS_FILEMUSTEXIST|FOS_PATHMUSTEXIST|FOS_FORCEFILESYSTEM|FOS_DONTADDTORECENT|FOS_NOCHANGEDIR).map_err(|_|"source_chooser_unavailable")?;
   dialog.SetFileTypes(&[COMDLG_FILTERSPEC{pszName:w!("Published work registry JSON"),pszSpec:w!("*.json")}]).map_err(|_|"source_chooser_unavailable")?;
   if let Err(error)=dialog.Show(Some(window.hwnd().map_err(|_|"source_chooser_unavailable")?)){if error.code().0==0x800704C7u32 as i32{return Ok(None);}return Err("source_selection_denied".into());}
   let item=dialog.GetResult().map_err(|_|"source_selection_denied")?;let raw=item.GetDisplayName(SIGDN_FILESYSPATH).map_err(|_|"source_selection_denied")?;
   let selected=PCWSTR(raw.0).to_string();CoTaskMemFree(Some(raw.0.cast()));let path=PathBuf::from(selected.map_err(|_|"invalid_selected_source")?);
   Ok(Some(grants().lock().map_err(|_|"source_grant_unavailable")?.select(window.label(),&path)?))
  }
 }
 #[cfg(not(windows))] {let _=window;Err("source_chooser_unavailable".into())}
}
#[tauri::command(rename_all="camelCase")]
pub fn read_registry_source(window:tauri::WebviewWindow,grant_id:String,expected_digest:Option<String>)->Result<SnapshotRead,String>{grants().lock().map_err(|_|"source_grant_unavailable")?.read(window.label(),&grant_id,expected_digest.as_deref())}
#[tauri::command(rename_all="camelCase")]
pub fn revoke_registry_source(window:tauri::WebviewWindow,grant_id:String)->Result<(),String>{grants().lock().map_err(|_|"source_grant_unavailable")?.revoke(window.label(),&grant_id);Ok(())}
// Keep the capability lock until the existing projection CAS commits, so revoke
// and confirm have one ordering. This command has no task/run/timer write path.
#[tauri::command(rename_all="camelCase")]
pub fn commit_registry_source(window:tauri::WebviewWindow,grant_id:String,expected_digest:String,value:String,expected_value:String,expected_sources:String,state:tauri::State<'_,AppState>)->Result<(),String>{
 let mut guard=grants().lock().map_err(|_|"source_grant_unavailable")?;
 let conn=state.0.lock().map_err(|_|"database lock poisoned")?;
 commit(&mut guard,window.label(),&grant_id,&expected_digest,&value,&expected_value,&expected_sources,&conn)
}
// The same published v1 schema is checked again at the protected write boundary.
// This does not import tasks or introduce another format/projection engine.
fn validate_selected_snapshot(s:&Value)->Result<(),String>{
 fn exact(v:&Value,keys:&[&str])->bool{v.as_object().is_some_and(|o|o.len()==keys.len()&&keys.iter().all(|k|o.contains_key(*k)))}
 fn id(v:&Value,max:usize)->bool{v.as_str().is_some_and(|v|!v.is_empty()&&v.len()<=max&&v.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'_'||b==b'-'))}
 fn text(v:&Value,max:usize)->bool{v.as_str().is_some_and(|v|!v.trim().is_empty()&&v.encode_utf16().count()<=max&&!v.chars().any(|c|(c as u32)<32))}
 fn date(v:&Value)->Option<chrono::DateTime<chrono::FixedOffset>>{let s=v.as_str()?;if !s.ends_with('Z')||!(s.len()==20||(22..=24).contains(&s.len())){return None;}chrono::DateTime::parse_from_rfc3339(s).ok()}
 let invalid=||"invalid_work_registry".to_owned();
 if !exact(s,&["schemaVersion","kind","snapshotId","sequence","source","publishedAt","staleAfterSeconds","projects","tasks","runs"])||s["schemaVersion"]!=1||s["kind"]!="work-registry-snapshot"||!id(&s["snapshotId"],100)||s["sequence"].as_u64().is_none_or(|n|n==0||n>9007199254740991){return Err(invalid());}
 let source=&s["source"];if !exact(source,&["publisherId","sourceNamespace","mode"])||!id(&source["publisherId"],100)||source["mode"]!="published-snapshot"{return Err(invalid());}
 let ns=source["sourceNamespace"].as_str().ok_or_else(invalid)?;if uuid::Uuid::parse_str(ns).map(|u|u.to_string()!=ns).unwrap_or(true){return Err(invalid());}
 let published=date(&s["publishedAt"]).ok_or_else(invalid)?;
 if s["staleAfterSeconds"].as_u64().is_none_or(|n|!(60..=604800).contains(&n)){return Err(invalid());}
 let projects=s["projects"].as_array().filter(|v|v.len()<=100).ok_or_else(invalid)?;let tasks=s["tasks"].as_array().filter(|v|v.len()<=1000).ok_or_else(invalid)?;
 if !s["runs"].as_array().is_some_and(|v|v.is_empty()){return Err(invalid());}
 let mut project_ids=std::collections::HashSet::new();for p in projects{if !exact(p,&["id","title"])||!id(&p["id"],100)||!text(&p["title"],200)||!project_ids.insert(p["id"].as_str().unwrap()){return Err(invalid());}}
 let mut task_ids=HashMap::new();for t in tasks{
  if !exact(t,&["id","projectId","parentTaskId","title","relationship","status","lastUpdated","provenance","operation","waitingFor","result","localBinding"])||!id(&t["id"],100)||!text(&t["title"],500)||!project_ids.contains(t["projectId"].as_str().unwrap_or(""))||date(&t["lastUpdated"]).is_none_or(|d|d>published){return Err(invalid());}
  if !["planned","running","waiting","checking","decision-needed","done","error","cancelled","unknown"].contains(&t["status"].as_str().unwrap_or(""))||!["root","parallel","sequential"].contains(&t["relationship"].as_str().unwrap_or(""))||t["parentTaskId"].is_null()!=(t["relationship"]=="root"){return Err(invalid());}
  let p=&t["provenance"];if !exact(p,&["kind","reference"])||p["kind"]!="parent-published"||!text(&p["reference"],500){return Err(invalid());}
  for k in ["operation","waitingFor","result"]{if !t[k].is_null()&&!text(&t[k],2000){return Err(invalid());}}
  let b=&t["localBinding"];if !b.is_null(){
   if !exact(b,&["sourceNamespace","sourceType","sourceId","taskKey"])||b["sourceType"]!="note"||!id(&b["sourceId"],100){return Err(invalid());}
   let ns=b["sourceNamespace"].as_str().unwrap_or("");if ns.len()!=36||!ns.bytes().all(|c|c.is_ascii_digit()||(b'a'..=b'f').contains(&c)||c==b'-'){return Err(invalid());}
   let key=b["taskKey"].as_str().unwrap_or("");if key.len()<25||!key.starts_with("cicada-")||key.as_bytes().get(23)!=Some(&b'-')||!key.as_bytes()[7..23].iter().all(|c|c.is_ascii_digit()||(b'a'..=b'f').contains(c))||!id(&Value::String(key[24..].to_owned()),80){return Err(invalid());}
  }
  if task_ids.insert(t["id"].as_str().unwrap(),t).is_some(){return Err(invalid());}
 }
 for t in tasks{let mut seen=std::collections::HashSet::from([t["id"].as_str().unwrap()]);let mut parent=&t["parentTaskId"];while !parent.is_null(){let p=parent.as_str().and_then(|id|task_ids.get(id)).ok_or_else(invalid)?;if p["projectId"]!=t["projectId"]||!seen.insert(p["id"].as_str().unwrap()){return Err(invalid());}parent=&p["parentTaskId"];}}
 Ok(())
}
fn commit(grants:&mut Grants,owner:&str,id:&str,digest:&str,value:&str,expected:&str,expected_sources:&str,conn:&rusqlite::Connection)->Result<(),String>{
 let selected=grants.read(owner,id,Some(digest))?;
 if value.len()>4*1024*1024{return Err("registry_storage_limit".into());}
 let tx=conn.unchecked_transaction().map_err(|_|"source_config_unavailable")?;
 if crate::mvp_sync_db::read_ui(&tx,SOURCES)?.unwrap_or_default()!=expected_sources{return Err("source_config_changed".into());}
 let snapshot:Value=serde_json::from_str(&selected.raw).map_err(|_|"source_json_required")?;
 validate_selected_snapshot(&snapshot)?;
 let publisher=snapshot["source"]["publisherId"].as_str().ok_or("source_identity_required")?;let namespace=snapshot["source"]["sourceNamespace"].as_str().ok_or("source_identity_required")?;
 let key=format!("{publisher}:{namespace}");
 let mut next:serde_json::Map<String,Value>=if expected.is_empty(){serde_json::Map::new()}else{serde_json::from_str(expected).map_err(|_|"registry_invalid_previous")?};
 if let Some(previous)=next.get(&key){let seq=snapshot["sequence"].as_u64().ok_or("registry_invalid_sequence")?;let old=previous["sequence"].as_u64().ok_or("registry_invalid_sequence")?;if seq<old||(seq==old&&previous!=&snapshot){return Err("registry_sequence_conflict".into());}}
 next.insert(key,snapshot);
 let proposed:Value=serde_json::from_str(value).map_err(|_|"registry_invalid_projection")?;if proposed!=Value::Object(next){return Err("source_projection_mismatch".into());}
 crate::mvp_sync_db::set_ui_in_transaction(&tx,REGISTRY,value,Some(expected))?;
 grants.read(owner,id,Some(digest))?;
 tx.commit().map_err(|_|"source_confirmation_failed".into())
}

#[cfg(test)]
mod tests {
 use super::*;
 fn fixture()->Value{serde_json::json!({"schemaVersion":1,"kind":"work-registry-snapshot","snapshotId":"owned-snapshot","sequence":1,"source":{"publisherId":"owned","sourceNamespace":"00000000-0000-0000-0000-000000000001","mode":"published-snapshot"},"projects":[{"id":"owned-project","title":"Owned project"}],"tasks":[],"runs":[],"publishedAt":"2026-10-18T12:00:00Z","staleAfterSeconds":3600})}
 fn file(dir:&Path)->PathBuf{let p=dir.join("owned.json");std::fs::write(&p,fixture().to_string()).unwrap();p}
 #[test]
 fn registry_source_exact_grant_owner_revoke_expiry_and_changed_bytes_fail_closed(){
  let dir=tempfile::tempdir().unwrap();let path=file(dir.path());let original=std::fs::read(&path).unwrap();let mut grants=Grants::default();let selected=grants.select("owner",&path).unwrap();
  assert!(grants.read("other",&selected.grant_id,None).is_err());let read=grants.read("owner",&selected.grant_id,None).unwrap();assert_eq!(read.raw,fixture().to_string());
  assert!(grants.read("owner","invented-path-or-grant",None).is_err());grants.revoke("other",&selected.grant_id);assert!(grants.read("owner",&selected.grant_id,Some(&read.digest)).is_ok());
  grants.revoke("owner",&selected.grant_id);assert!(grants.read("owner",&selected.grant_id,None).is_err());
  let selected=grants.select("owner",&path).unwrap();grants.entries.get_mut(&selected.grant_id).unwrap().created=Instant::now()-Duration::from_secs(601);assert!(grants.read("owner",&selected.grant_id,None).is_err());
  let selected=grants.select("owner",&path).unwrap();std::fs::write(&path,b"{}").unwrap();assert!(grants.read("owner",&selected.grant_id,None).is_err());assert!(!grants.entries.contains_key(&selected.grant_id));std::fs::write(&path,&original).unwrap();
  #[cfg(unix)] {use std::os::unix::fs::PermissionsExt;let selected=grants.select("owner",&path).unwrap();std::fs::set_permissions(&path,std::fs::Permissions::from_mode(0o000)).unwrap();if File::open(&path).is_err(){assert!(grants.read("owner",&selected.grant_id,None).is_err());}std::fs::set_permissions(&path,std::fs::Permissions::from_mode(0o600)).unwrap();}
  let selected=grants.select("owner",&path).unwrap();std::fs::remove_file(&path).unwrap();assert!(grants.read("owner",&selected.grant_id,None).is_err());assert!(dir.path().read_dir().unwrap().next().is_none());
 }
 #[test]
 fn registry_source_bounds_links_and_replaced_identity_are_rejected(){
  let dir=tempfile::tempdir().unwrap();let path=file(dir.path());let mut grants=Grants::default();assert!(grants.select("owner",Path::new("pasted-relative.json")).is_err());
  let large=dir.path().join("large.json");std::fs::write(&large,vec![b' ';MAX_BYTES as usize+1]).unwrap();assert!(grants.select("owner",&large).is_err());
  let many=dir.path().join("many.json");let mut v=fixture();v["tasks"]=serde_json::json!(vec![serde_json::json!({});1001]);std::fs::write(&many,v.to_string()).unwrap();let s=grants.select("owner",&many).unwrap();assert!(grants.read("owner",&s.grant_id,None).is_err());
  #[cfg(unix)] {let link=dir.path().join("link.json");std::os::unix::fs::symlink(&path,&link).unwrap();assert!(grants.select("owner",&link).is_err());let selected=grants.select("owner",&path).unwrap();std::fs::rename(&path,dir.path().join("old.json")).unwrap();file(dir.path());assert!(grants.read("owner",&selected.grant_id,None).is_err());}
 }
 #[test]
 fn registry_source_confirmation_is_exact_projection_cas_and_preserves_source_and_native_data(){
  let dir=tempfile::tempdir().unwrap();let path=file(dir.path());let original=std::fs::read(&path).unwrap();let mut grants=Grants::default();let s=grants.select("owner",&path).unwrap();let read=grants.read("owner",&s.grant_id,None).unwrap();
  let conn=rusqlite::Connection::open_in_memory().unwrap();crate::init_schema(&conn).unwrap();
  let value=serde_json::json!({"owned:00000000-0000-0000-0000-000000000001":fixture()}).to_string();
  let counts=||->(i64,i64){(conn.query_row("SELECT count(*) FROM items",[],|r|r.get(0)).unwrap(),conn.query_row("SELECT count(*) FROM timeline_blocks",[],|r|r.get(0)).unwrap())};let before=counts();
  assert!(commit(&mut grants,"other",&s.grant_id,&read.digest,&value,"","",&conn).is_err());assert!(commit(&mut grants,"owner",&s.grant_id,&read.digest,"{}","","",&conn).is_err());
  commit(&mut grants,"owner",&s.grant_id,&read.digest,&value,"","",&conn).unwrap();assert_eq!(crate::mvp_sync_db::read_ui(&conn,REGISTRY).unwrap().unwrap(),value);assert_eq!(counts(),before);assert_eq!(std::fs::read(&path).unwrap(),original);
  commit(&mut grants,"owner",&s.grant_id,&read.digest,&value,&value,"",&conn).unwrap();assert!(commit(&mut grants,"owner",&s.grant_id,&read.digest,&value,"","",&conn).is_err());
  crate::mvp_sync_db::set_ui(&conn,SOURCES,"changed",Some("")).unwrap();assert!(commit(&mut grants,"owner",&s.grant_id,&read.digest,&value,&value,"",&conn).is_err());assert_eq!(crate::mvp_sync_db::read_ui(&conn,REGISTRY).unwrap().unwrap(),value);
  grants.revoke("owner",&s.grant_id);assert!(commit(&mut grants,"owner",&s.grant_id,&read.digest,&value,&value,"changed",&conn).is_err());assert_eq!(counts(),before);assert_eq!(std::fs::read(&path).unwrap(),original);
 }
 #[test]
 fn registry_source_invalid_rows_cannot_bypass_preview_at_confirmation(){
  let dir=tempfile::tempdir().unwrap();let path=file(dir.path());let mut value=fixture();value["tasks"]=serde_json::json!([{"id":"duplicate"},{"id":"duplicate"}]);std::fs::write(&path,value.to_string()).unwrap();
  let mut grants=Grants::default();let selected=grants.select("owner",&path).unwrap();let read=grants.read("owner",&selected.grant_id,None).unwrap();let conn=rusqlite::Connection::open_in_memory().unwrap();crate::init_schema(&conn).unwrap();
  let proposed=serde_json::json!({"owned:00000000-0000-0000-0000-000000000001":value}).to_string();assert!(commit(&mut grants,"owner",&selected.grant_id,&read.digest,&proposed,"","",&conn).is_err());assert!(crate::mvp_sync_db::read_ui(&conn,REGISTRY).unwrap().is_none());
 }

}

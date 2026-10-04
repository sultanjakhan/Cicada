//! Local personal AI work; task + binding + report + operation receipt commit together.
//! No model dispatch, shell, corporate data, implicit task completion or human timer.
use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

const EXCHANGE: &str = "calendar_task_run_exchange_v1";
const OPERATIONS: &str = "calendar_agent_operations_v1";
const MAX_STATE: usize = 4 * 1024 * 1024;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Request { pub version: u32, pub operation_id: String, pub action: String, pub body: Value }
#[derive(Deserialize,Serialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
struct Begin { title: String, content: String, task_id: Option<String>, expected_version: Option<i64>, projects: Vec<String>, report: Report }
#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
struct Report {
    run_id: String, sequence: u64, task_key: Option<String>, agent: String, model: Option<String>,
    provider: Option<String>, stage: Option<String>, status: String, skill_ids: Vec<String>,
    mcp_calls: Option<Vec<Counter>>, input_tokens: Option<u64>, output_tokens: Option<u64>,
}
#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Counter { server: String, tool: String, calls: u64 }
fn err() -> String { "agent_request_rejected".into() }
pub(crate) fn token(s:&str, min:usize, max:usize)->bool { (min..=max).contains(&s.len()) && s.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'_'||b==b'-') }
fn label(value:&Option<String>, limit:usize)->bool { value.as_ref().is_none_or(|s|!s.trim().is_empty()&&s.chars().count()<=limit&&!s.chars().any(char::is_control)) }
fn validate_report(mut r:Report)->Result<Report,String> {
    if !token(&r.run_id,8,100)|| !(1..=1_000_000_000).contains(&r.sequence)||
        !["codex","claude","other","agent-city"].contains(&r.agent.as_str())||
        !["running","waiting","done","error","cancelled"].contains(&r.status.as_str())||
        !label(&r.model,200)||!label(&r.provider,80)||!label(&r.stage,120)||r.skill_ids.len()>40||
        r.skill_ids.iter().any(|id|!id.starts_with("skill-")||id.len()!=30||!id[6..].bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b)))||
        [r.input_tokens,r.output_tokens].iter().flatten().any(|v|*v>1_000_000_000_000) {return Err(err())}
    r.skill_ids.sort(); r.skill_ids.dedup();
    if let Some(calls)=&mut r.mcp_calls {
        if calls.len()>30 {return Err(err())}
        let good=|v:&str|!v.is_empty()&&v.len()<=100&&v.bytes().all(|b|b.is_ascii_alphanumeric()||b"_.:-".contains(&b));
        if calls.iter().any(|c|!good(&c.server)||!good(&c.tool)||c.calls>1_000_000_000_000){return Err(err())}
        calls.sort_by(|a,b|(&a.server,&a.tool).cmp(&(&b.server,&b.tool)));
        if calls.windows(2).any(|w|w[0].server==w[1].server&&w[0].tool==w[1].tool){return Err(err())}
    }
    Ok(r)
}
pub(crate) fn read(conn:&Connection,key:&str)->Result<Option<Value>,String> {
    if crate::agent_history::ready(conn) {
        if key==EXCHANGE {return crate::agent_history::load(conn).map(Some)}
        if key==OPERATIONS {return crate::agent_history::receipts(conn).map(Some)}
        if key=="calendar_agent_report_times_v1" {return crate::agent_history::times(conn).map(Some)}
    }
    let raw:Option<String>=conn.query_row("SELECT value FROM ui_state WHERE key=?1",[key],|r|r.get(0)).optional().map_err(|_|err())?;
    raw.map(|s|if s.len()>MAX_STATE {Err(err())}else{serde_json::from_str(&s).map_err(|_|err())}).transpose()
}
pub(crate) fn write(conn:&Connection,key:&str,value:&Value)->Result<(),String> {
    if key==EXCHANGE {return crate::agent_history::save(conn,value)}
    if key==OPERATIONS && crate::agent_history::ready(conn) {
        validate_operations(value)?;
        for (id,receipt) in value.as_object().unwrap() {
            if crate::agent_history::receipt(conn,id)?.is_none() {crate::agent_history::insert_receipt(conn,id,receipt["digest"].as_str().unwrap(),&receipt["result"])?;}
        }
        return Ok(())
    }
    let raw=value.to_string();if raw.len()>MAX_STATE{return Err(err())}
    conn.execute("INSERT INTO ui_state(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",rusqlite::params![key,raw,chrono::Utc::now().to_rfc3339()]).map_err(|_|err())?;Ok(())
}
pub(crate) fn personal(conn:&Connection,id:&str)->Result<Value,String> {
    personal_with_archive(conn,id,false)
}
fn personal_with_archive(conn:&Connection,id:&str,allow_archived:bool)->Result<Value,String> {
    if !token(id,1,80){return Err(err())}
    let row:(String,String,i64,i64,i64,String)=conn.query_row("SELECT kind,tags,archived,completed,version,status FROM items WHERE id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).map_err(|_|err())?;
    if row.0!="task"||(!allow_archived&&row.2!=0)||!row.1.split(',').any(|s|s.trim()=="task-sphere:personal")||row.1.split(',').any(|s|{let t=s.trim().to_ascii_lowercase();t.starts_with("jira")||t.starts_with("investlink")||t=="task-sphere:work"}){return Err("personal_task_required".into())}
    let (title,content):(String,String)=conn.query_row("SELECT title,notes FROM items WHERE id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|_|err())?;
    Ok(json!({"id":id,"title":title,"content":content,"version":row.4,"completed":row.3!=0,"status":row.5}))
}
pub(crate) fn exchange(conn:&Connection)->Result<Value,String> {
    crate::agent_history::load(conn)
}
pub(crate) fn validate_exchange(state:&Value)->Result<(),String> {
    let keys=["version","sourceNamespace","order","bindings","runs"];
    if state.as_object().is_none_or(|s|s.len()!=5||keys.iter().any(|k|!s.contains_key(*k)))||state["version"]!=1||
        state["sourceNamespace"].as_str().is_none_or(|s|Uuid::parse_str(s).is_err()||Uuid::parse_str(s).unwrap().to_string()!=s)||state["order"].as_u64().is_none()||
        state["order"].as_u64().is_some_and(|n|n>9_007_199_254_740_991)||
        !state["bindings"].is_object()||!state["runs"].is_object(){return Err("exchange_state_invalid".into())}
    for (key,b) in state["bindings"].as_object().unwrap(){
        let id=b["sourceId"].as_str().ok_or_else(err)?;
        if !token(id,1,80)||*b!=binding(&state,id)||b["taskKey"]!=*key{return Err("exchange_state_invalid".into())}
    }
    for (id,run) in state["runs"].as_object().unwrap(){
        if run.as_object().is_none_or(|r|r.len()!=7)||run["runId"]!=*id||run["receivedOrder"].as_u64().is_none_or(|n|n>state["order"].as_u64().unwrap())||
            run["taskKey"].as_str().is_none_or(|key|state["bindings"].get(key).is_none()){return Err("exchange_state_invalid".into())}
        let input=json!({"runId":id,"sequence":1,"taskKey":run["taskKey"],"agent":run["agent"],"model":run["model"],"provider":run["provider"],"stage":null,"status":"running","skillIds":[],"mcpCalls":null,"inputTokens":null,"outputTokens":null});
        validate_report(serde_json::from_value(input).map_err(|_|err())?)?;
        if !run["report"].is_null(){
            let r=validate_report(serde_json::from_value(run["report"].clone()).map_err(|_|err())?)?;
            if serde_json::to_value(&r).map_err(|_|err())?!=run["report"]||r.run_id!=*id||["taskKey","agent","model","provider"].iter().any(|k|run[*k]!=run["report"][*k]){return Err("exchange_state_invalid".into())}
        }
    }
    Ok(())
}
pub(crate) fn binding(state:&Value,id:&str)->Value {
    let ns=state["sourceNamespace"].as_str().unwrap();let prefix=hex::encode(Sha256::digest(ns.as_bytes()));
    json!({"sourceNamespace":ns,"sourceType":"note","sourceId":id,"taskKey":format!("cicada-{}-{id}",&prefix[..16])})
}
fn apply_report(state:&mut Value,b:&Value,input:Report)->Result<Report,String> {
    let mut r=validate_report(input)?;let key=b["taskKey"].as_str().unwrap();
    if r.task_key.as_ref().is_some_and(|k|k!=key){return Err("task_binding_mismatch".into())}
    r.task_key=Some(key.into());
    if let Some(prior)=state["runs"].get(&r.run_id) {
        if prior["taskKey"]!=json!(r.task_key)||prior["agent"]!=r.agent||prior["model"]!=json!(r.model)||prior["provider"]!=json!(r.provider){return Err("run_sequence_or_identity_conflict".into())}
    }
    if let Some(prior)=state["runs"].get(&r.run_id).filter(|prior|!prior["report"].is_null()) {
        let old:Report=serde_json::from_value(prior["report"].clone()).map_err(|_|err())?;
        if old==r{return Ok(r)}
        if old.sequence>=r.sequence||old.agent!=r.agent||old.model!=r.model||old.provider!=r.provider||old.task_key!=r.task_key{return Err("run_sequence_or_identity_conflict".into())}
        if ["done","error","cancelled"].contains(&old.status.as_str())&&old.status!=r.status{return Err("new_run_id_required".into())}
        if [(old.input_tokens,r.input_tokens),(old.output_tokens,r.output_tokens)].iter().any(|(a,b)|a.is_some_and(|a|b.is_none_or(|b|b<a))){return Err("usage_decreased".into())}
        for c in old.mcp_calls.unwrap_or_default(){if !r.mcp_calls.as_ref().is_some_and(|cs|cs.iter().any(|n|n.server==c.server&&n.tool==c.tool&&n.calls>=c.calls)){return Err("usage_decreased".into())}}
    }
    let order=state["order"].as_u64().unwrap()+1;state["order"]=json!(order);
    state["runs"][&r.run_id]=json!({"runId":r.run_id,"taskKey":r.task_key,"agent":r.agent,"model":r.model,"provider":r.provider,"report":r,"receivedOrder":order});Ok(r)
}
pub(crate) fn execute(conn:&mut Connection,mut req:Request)->Result<Value,String> {
    if req.version!=1||!token(&req.operation_id,8,100){return Err(err())}
    if req.action=="task-command" {
        if req.body.as_object().is_none_or(|b|b.len()!=2||!b.contains_key("command")||!b.contains_key("arguments")){return Err(err())}
        let command=req.body["command"].as_str().ok_or_else(err)?;
        return Ok(crate::shared_tasks::execute(conn,&req.operation_id,command,req.body["arguments"].clone()));
    }
    if req.action=="get" {
        if req.body.as_object().is_none_or(|b|b.len()!=1){return Err(err())}
        return personal(conn,req.body["taskId"].as_str().ok_or_else(err)?);
    }
    if req.action=="list" {
        if req.body!=json!({}){return Err(err())}
        let mut query=conn.prepare("SELECT id FROM items WHERE kind='task' AND archived=0 AND instr(',' || tags || ',',',task-sphere:personal,')>0 ORDER BY updated_at DESC,id LIMIT 101").map_err(|_|err())?;
        let ids=query.query_map([],|r|r.get::<_,String>(0)).map_err(|_|err())?.collect::<Result<Vec<_>,_>>().map_err(|_|err())?;
        let rows=ids.iter().take(100).filter_map(|id|personal(conn,id).ok()).map(|mut task|{task.as_object_mut().unwrap().remove("content");task}).collect::<Vec<_>>();return Ok(json!({"tasks":rows,"hasMore":ids.len()>100}));
    }
    if !["begin","report"].contains(&req.action.as_str()){return Err(err())}
    if req.action=="begin" {
        let mut input:Begin=serde_json::from_value(req.body).map_err(|_|err())?;
        input.title=input.title.trim().into();input.projects.sort();input.projects.dedup();input.report=validate_report(input.report)?;
        req.body=serde_json::to_value(input).map_err(|_|err())?;
    }
    let digest=hex::encode(Sha256::digest(json!({"action":req.action,"body":req.body}).to_string().as_bytes()));
    let tx=conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_|err())?;
    crate::agent_history::ensure(&tx)?;
    if let Some(receipt)=crate::agent_history::receipt(&tx,&req.operation_id)?{if receipt["digest"]!=digest{return Err("operation_payload_conflict".into())}personal_with_archive(&tx,receipt["result"]["task"]["id"].as_str().ok_or_else(err)?,true)?;tx.commit().map_err(|_|err())?;return Ok(receipt["result"].clone())}
    let (task,input)=if req.action=="begin" {
        let input:Begin=serde_json::from_value(req.body).map_err(|_|err())?;
        if input.report.status!="running"||input.report.sequence!=1||input.content.len()>16000||input.projects.len()>10||input.projects.iter().any(|p|!token(p,1,80)){return Err(err())}
        let id=if let Some(id)=input.task_id { let task=personal(&tx,&id)?;if task["completed"]==true{return Err("task_already_completed".into())}if input.expected_version!=task["version"].as_i64(){return Err("task_version_conflict".into())}id }else{
            if input.expected_version.is_some(){return Err(err())}
            let tags=format!("task-sphere:personal,source:ai,{}",input.projects.iter().map(|p|format!("project:{p}")).collect::<Vec<_>>().join(","));
            crate::calendar_compat::create_note_in_transaction(&tx,&input.title,&input.content,&tags,"task",&None,None)?.id
        };(personal(&tx,&id)?,input.report)
    }else{
        #[derive(Deserialize)]#[serde(rename_all="camelCase",deny_unknown_fields)]struct Input {task_id:String,expected_version:i64,report:Report}
        let input:Input=serde_json::from_value(req.body).map_err(|_|err())?;let task=personal(&tx,&input.task_id)?;
        if task["version"]!=input.expected_version{return Err("task_version_conflict".into())}(task,input.report)
    };
    let id=task["id"].as_str().unwrap();
    let mut state=crate::agent_history::context(&tx,id,&input.run_id)?;
    let b=binding(&state,id);let key=b["taskKey"].as_str().unwrap();
    if req.action=="report"&&state["bindings"].get(key)!=Some(&b){return Err("unknown_task_binding".into())}
    let previous_order=state["order"].clone();
    state["bindings"][key]=b.clone();let row=apply_report(&mut state,&b,input)?;
    if previous_order!=state["order"] {record_received_at(&tx,&row.run_id)?;}
    let result=json!({"task":task,"binding":b,"report":row,"taskCompletedAutomatically":false});
    write(&tx,EXCHANGE,&state)?;crate::agent_history::insert_receipt(&tx,&req.operation_id,&digest,&result)?;
    tx.commit().map_err(|_|err())?;Ok(result)
}

pub(crate) fn record_received_at(c:&Connection,run:&str)->Result<(),String>{
    crate::agent_history::touch(c,run)
}
pub(crate) fn validate_operations(ops:&Value)->Result<(),String>{
    let map=ops.as_object().ok_or_else(err)?;
    if map.iter().any(|(id,receipt)|!token(id,8,100)||receipt.as_object().is_none_or(|r|r.len()!=2)||receipt["digest"].as_str().is_none_or(|d|d.len()!=64||!d.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b)))||!receipt["result"].is_object()){return Err("operation_state_invalid".into())}Ok(())
}

// Reject duplicate keys before converting nested objects to Value.
pub(crate) fn parse(raw:&[u8])->Result<Request,String>{
    use serde::de::{self,Visitor,MapAccess,SeqAccess};
    struct Unique(Value);
    impl<'de> Deserialize<'de> for Unique {
        fn deserialize<D:de::Deserializer<'de>>(d:D)->Result<Self,D::Error>{
            struct V;impl<'de> Visitor<'de> for V{
                type Value=Unique;
                fn expecting(&self,f:&mut std::fmt::Formatter)->std::fmt::Result{f.write_str("unique bounded JSON")}
                fn visit_bool<E:de::Error>(self,v:bool)->Result<Unique,E>{Ok(Unique(json!(v)))}
                fn visit_i64<E:de::Error>(self,v:i64)->Result<Unique,E>{Ok(Unique(json!(v)))}
                fn visit_u64<E:de::Error>(self,v:u64)->Result<Unique,E>{Ok(Unique(json!(v)))}
                fn visit_f64<E:de::Error>(self,v:f64)->Result<Unique,E>{if v.is_finite(){Ok(Unique(json!(v)))}else{Err(E::custom("number"))}}
                fn visit_str<E:de::Error>(self,v:&str)->Result<Unique,E>{Ok(Unique(json!(v)))}
                fn visit_string<E:de::Error>(self,v:String)->Result<Unique,E>{Ok(Unique(json!(v)))}
                fn visit_unit<E:de::Error>(self)->Result<Unique,E>{Ok(Unique(Value::Null))}
                fn visit_seq<A:SeqAccess<'de>>(self,mut a:A)->Result<Unique,A::Error>{let mut out=vec![];while let Some(Unique(v))=a.next_element()?{out.push(v)}Ok(Unique(Value::Array(out)))}
                fn visit_map<A:MapAccess<'de>>(self,mut a:A)->Result<Unique,A::Error>{let mut out=serde_json::Map::new();while let Some(key)=a.next_key::<String>()?{if out.contains_key(&key){return Err(de::Error::custom("duplicate key"))}let Unique(v)=a.next_value()?;out.insert(key,v);}Ok(Unique(Value::Object(out)))}
            }d.deserialize_any(V)
        }
    }
    if raw.len()>64*1024{return Err(err())}let Unique(v)=serde_json::from_slice(raw).map_err(|_|err())?;
    fn depth(v:&Value,n:usize)->bool{n<=32&&match v{Value::Object(m)=>m.values().all(|v|depth(v,n+1)),Value::Array(a)=>a.iter().all(|v|depth(v,n+1)),_=>true}}
    if !depth(&v,0){return Err(err())}serde_json::from_value(v).map_err(|_|err())
}

#[cfg(test)]mod tests{
    use super::*;
    fn conn()->Connection{let c=Connection::open_in_memory().unwrap();crate::init_schema(&c).unwrap();c}
    fn report(run:&str,status:&str,seq:u64)->Value{json!({"runId":run,"sequence":seq,"taskKey":null,"agent":"codex","model":null,"provider":null,"stage":null,"status":status,"skillIds":[],"mcpCalls":null,"inputTokens":null,"outputTokens":null})}
    fn call(c:&mut Connection,op:&str,action:&str,body:Value)->Result<Value,String>{execute(c,Request{version:1,operation_id:op.into(),action:action.into(),body})}
    fn begin(c:&mut Connection)->Value{call(c,"test-begin-001","begin",json!({"title":"Synthetic Ж 文 task","content":"Synthetic only","taskId":null,"projects":["cicada"],"report":report("test-run-001","running",1)})).unwrap()}
    #[test]fn begin_is_atomic_replay_and_compatible_with_native_exchange(){
        let mut c=conn();let a=begin(&mut c);let b=begin(&mut c);assert_eq!(a,b);
        assert_eq!(c.query_row("SELECT count(*) FROM items",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        let s=read(&c,EXCHANGE).unwrap().unwrap();assert_eq!(s["bindings"][a["binding"]["taskKey"].as_str().unwrap()],a["binding"]);
        assert_eq!(s["runs"]["test-run-001"]["report"],a["report"]);assert_eq!(a["task"]["completed"],false);
        assert_eq!(c.query_row("SELECT count(*) FROM timeline_blocks",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        let changed=call(&mut c,"test-begin-001","begin",json!({"title":"Different","content":"Synthetic only","taskId":null,"projects":["cicada"],"report":report("test-run-001","running",1)}));assert!(changed.is_err());
    }
    #[test]fn invalid_report_rolls_back_task_and_receipt(){
        let mut c=conn();let mut r=report("test-run-002","running",1);r["inputTokens"]=json!(-1);
        assert!(call(&mut c,"test-invalid-01","begin",json!({"title":"Synthetic","content":"","taskId":null,"projects":[],"report":r})).is_err());
        assert_eq!(c.query_row("SELECT count(*) FROM items",[],|r|r.get::<_,i64>(0)).unwrap(),0);assert!(read(&c,OPERATIONS).unwrap().is_none());
    }
    #[test]fn terminal_report_cannot_restart_or_complete_native_task(){
        let mut c=conn();let a=begin(&mut c);let id=a["task"]["id"].as_str().unwrap();
        call(&mut c,"test-done-001","report",json!({"taskId":id,"expectedVersion":1,"report":report("test-run-001","done",2)})).unwrap();
        assert!(call(&mut c,"test-resume-001","report",json!({"taskId":id,"expectedVersion":1,"report":report("test-run-001","running",3)})).is_err());
        assert_eq!(personal(&c,id).unwrap()["completed"],false);
    }
    #[test]fn unbound_foreign_task_and_counter_regressions_fail(){
        let mut c=conn();let a=begin(&mut c);let id=a["task"]["id"].as_str().unwrap();let mut r=report("test-run-001","running",2);r["inputTokens"]=json!(10);
        call(&mut c,"test-count-001","report",json!({"taskId":id,"expectedVersion":1,"report":r})).unwrap();
        assert!(call(&mut c,"test-count-002","report",json!({"taskId":id,"expectedVersion":1,"report":report("test-run-001","running",3)})).is_err());
        c.execute("UPDATE items SET tags='task-sphere:work' WHERE id=?1",[id]).unwrap();
        assert!(call(&mut c,"test-scope-001","get",json!({"taskId":id})).is_err());
        assert!(call(&mut c,"test-scope-002","report",json!({"taskId":id,"expectedVersion":1,"report":report("test-run-001","done",4)})).is_err());
    }
    #[test]fn strict_parser_rejects_nested_duplicates_and_extra_fields(){
        assert!(parse(br#"{"version":1,"operation_id":"test-parse-001","action":"get","body":{"taskId":"a","taskId":"b"}}"#).is_err());
        assert!(parse(br#"{"version":1,"operation_id":"test-parse-001","action":"list","body":{},"owner":"invented"}"#).is_err());
    }
    #[test]fn archived_personal_receipt_replays_but_new_writes_and_corporate_receipts_are_denied(){
        let mut c=conn();let a=begin(&mut c);let id=a["task"]["id"].as_str().unwrap();
        c.execute("UPDATE items SET archived=1 WHERE id=?1",[id]).unwrap();assert_eq!(begin(&mut c),a);
        assert_eq!(call(&mut c,"test-archived-01","report",json!({"taskId":id,"expectedVersion":1,"report":report("test-run-001","running",2)})).unwrap_err(),"personal_task_required");
        c.execute("UPDATE items SET tags='task-sphere:work' WHERE id=?1",[id]).unwrap();
        assert_eq!(call(&mut c,"test-begin-001","begin",json!({"title":"Synthetic Ж 文 task","content":"Synthetic only","taskId":null,"projects":["cicada"],"report":report("test-run-001","running",1)})).unwrap_err(),"personal_task_required");
    }
    #[test]fn replay_survives_reopen_and_full_capacity_while_stale_versions_fail(){
        let root=std::env::temp_dir().join(format!("cicada-agent-test-{}",Uuid::new_v4()));std::fs::create_dir(&root).unwrap();let path=root.join("synthetic.db");
        let mut c=Connection::open(&path).unwrap();crate::init_schema(&c).unwrap();let a=begin(&mut c);drop(c);
        let mut c=Connection::open(&path).unwrap();assert_eq!(a,begin(&mut c));
        let mut ops=read(&c,OPERATIONS).unwrap().unwrap();let receipt=ops["test-begin-001"].clone();for n in 1..500{ops[format!("synthetic-op-{n:04}")]=receipt.clone();}write(&c,OPERATIONS,&ops).unwrap();
        assert_eq!(a,begin(&mut c));
        let id=a["task"]["id"].as_str().unwrap().to_owned();
        call(&mut c,"test-after-500","report",json!({"taskId":id,"expectedVersion":1,"report":report("test-run-001","running",2)})).unwrap();
        assert_eq!(read(&c,OPERATIONS).unwrap().unwrap().as_object().unwrap().len(),501);
        drop(c);let mut c=Connection::open(&path).unwrap();assert_eq!(a,begin(&mut c));
        assert_eq!(c.query_row("SELECT count(*) FROM items",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        assert_eq!(c.query_row("SELECT count(*) FROM timeline_blocks",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        let id=a["task"]["id"].as_str().unwrap();c.execute("UPDATE items SET version=2 WHERE id=?1",[id]).unwrap();
        assert_eq!(call(&mut c,"test-stale-001","report",json!({"taskId":id,"expectedVersion":1,"report":report("test-run-001","done",3)})).unwrap_err(),"task_version_conflict");
        assert_eq!(read(&c,EXCHANGE).unwrap().unwrap()["runs"]["test-run-001"]["report"]["status"],"running");drop(c);
        std::fs::remove_file(path).unwrap();std::fs::remove_dir(root).unwrap();
    }
}


pub(crate) fn record_report(state:&mut Value,b:&Value,report:Value)->Result<Value,String>{let r=serde_json::from_value(report).map_err(|_|err())?;serde_json::to_value(apply_report(state,b,r)?).map_err(|_|err())}

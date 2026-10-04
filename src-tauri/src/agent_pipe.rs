//! Windows named pipe restricted to the creating account, never a TCP listener.
use std::{ffi::c_void, path::Path};
use sha2::{Digest,Sha256};
use tokio::{io::{AsyncReadExt,AsyncWriteExt},net::windows::named_pipe::ServerOptions};
use tauri::{Manager,Emitter};
use serde_json::json;
const LIMIT:usize=64*1024;
#[repr(C)]struct Security {len:u32,descriptor:*mut c_void,inherit:i32}
#[link(name="advapi32")]unsafe extern "system" {
    fn OpenProcessToken(process:*mut c_void,access:u32,token:*mut *mut c_void)->i32;
    fn GetTokenInformation(token:*mut c_void,class:u32,out:*mut c_void,len:u32,needed:*mut u32)->i32;
    fn ConvertSidToStringSidW(sid:*mut c_void,text:*mut *mut u16)->i32;
    fn ConvertStringSecurityDescriptorToSecurityDescriptorW(text:*const u16,rev:u32,out:*mut *mut c_void,len:*mut u32)->i32;
}
#[link(name="kernel32")]unsafe extern "system" {
    fn GetCurrentProcess()->*mut c_void;
    fn CloseHandle(handle:*mut c_void)->i32;
    fn LocalFree(handle:*mut c_void)->*mut c_void;
}
struct Descriptor(*mut c_void);
impl Drop for Descriptor {fn drop(&mut self){unsafe{LocalFree(self.0);}}}
fn security()->Result<(String,Descriptor),String>{unsafe{
    let mut token=std::ptr::null_mut();
    if OpenProcessToken(GetCurrentProcess(),8,&mut token)==0{return Err("agent_pipe_identity".into())}
    let mut needed=0;GetTokenInformation(token,1,std::ptr::null_mut(),0,&mut needed);
    if needed==0||needed>65536{CloseHandle(token);return Err("agent_pipe_identity".into())}
    let mut info=vec![0u8;needed as usize];
    let good=GetTokenInformation(token,1,info.as_mut_ptr().cast(),needed,&mut needed)!=0;CloseHandle(token);
    if !good{return Err("agent_pipe_identity".into())}
    let sid=std::ptr::read_unaligned(info.as_ptr().cast::<*mut c_void>());let mut text=std::ptr::null_mut();
    if ConvertSidToStringSidW(sid,&mut text)==0{return Err("agent_pipe_identity".into())}
    let mut len=0;while *text.add(len)!=0&&len<256{len+=1}
    let account=String::from_utf16(std::slice::from_raw_parts(text,len));LocalFree(text.cast());
    let account=account.map_err(|_|"agent_pipe_identity")?;
    // .NET CurrentUserOnly clients verify the owner as well as the DACL.
    // An elevated token's default owner can otherwise be Administrators.
    let sddl=format!("O:{account}D:P(A;;GA;;;{account})").encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    let mut descriptor=std::ptr::null_mut();
    if ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(),1,&mut descriptor,std::ptr::null_mut())==0{return Err("agent_pipe_security".into())}
    Ok((account,Descriptor(descriptor)))
}}
fn create(name:&str)->Result<tokio::net::windows::named_pipe::NamedPipeServer,String>{
    let (_,descriptor)=security()?;
    let attributes=Security{len:std::mem::size_of::<Security>() as u32,descriptor:descriptor.0,inherit:0};
    unsafe{ServerOptions::new().first_pipe_instance(true).max_instances(1).reject_remote_clients(true)
        .create_with_security_attributes_raw(name,(&attributes as *const Security).cast_mut().cast())}.map_err(|_|"agent_pipe_unavailable".into())
}
pub(crate) fn start(app:tauri::AppHandle,root:&Path)->Result<(),String>{
    let (account,_)=security()?;
    let canonical=root.canonicalize().map_err(|_|"agent_pipe_profile")?;
    let text=canonical.to_string_lossy();
    let normal=text.strip_prefix(r"\\?\").unwrap_or(&text);
    let identity=format!("{account}\n{}",normal.to_uppercase());
    let hash=hex::encode(Sha256::digest(identity.as_bytes()));let name=format!(r"\\.\pipe\CicadaAgent-{}",&hash[..32]);
    // The OS copies this descriptor when creating the exclusively owned pipe.
    let mut server=tauri::async_runtime::block_on(async {create(&name)})?;
    tauri::async_runtime::spawn(async move {
        loop {
            if server.connect().await.is_err(){break}
            let mut bytes=Vec::new();let mut one=[0u8];
            let frame=tokio::time::timeout(std::time::Duration::from_secs(3),async {
                while bytes.len()<LIMIT {
                    if server.read(&mut one).await.map_err(|_|())?==0{return Err(())}
                    if one[0]==10{return Ok(())}bytes.push(one[0]);
                }Err(())
            }).await;
            let reply=if matches!(frame,Ok(Ok(()))){
                let handle=app.clone();let result=tauri::async_runtime::spawn_blocking(move||{
                    let request=crate::agent_access::parse(&bytes)?;
                    let changed=request.action=="begin"||request.action=="report"||(request.action=="task-command"&&request.body["command"].as_str().is_some_and(|c|!["snapshot","get","operation"].contains(&c)));
                    let state=handle.state::<crate::AppState>();let mut conn=state.0.lock().map_err(|_|"agent_database_busy".to_string())?;
                    let result=crate::agent_access::execute(&mut conn,request)?;drop(conn);
                    if changed{let _=handle.emit("mvp-sync-updated",json!({"views_changed":true}));}
                    Ok::<_,String>(result)
                }).await;
                match result{Ok(Ok(value))=>json!({"ok":true,"result":value}),Ok(Err(error))=>json!({"ok":false,"error":error}),Err(_)=>json!({"ok":false,"error":"agent_outcome_unknown"})}
            }else{json!({"ok":false,"error":"invalid_agent_frame"})};
            let mut raw=reply.to_string().into_bytes();raw.push(10);
            if raw.len()<=1024*1024 {
                let sent=tokio::time::timeout(std::time::Duration::from_secs(3),async{server.write_all(&raw).await?;server.flush().await}).await;
                // Windows DisconnectNamedPipe discards unread buffered replies.
                // Tokio flush is not FlushFileBuffers: wait for the client's
                // bounded acknowledgement that it consumed the complete frame.
                if matches!(sent,Ok(Ok(()))){let _=tokio::time::timeout(std::time::Duration::from_secs(3),server.read(&mut one)).await;}
            }
            let _=server.disconnect();drop(server);
            // A client can close immediately after acknowledging. Recreate the
            // exclusively owned instance instead of retiring the whole endpoint
            // on an already-disconnected connection.
            let mut next=None;
            for _ in 0..40 {
                // Yield while the client and reactor release the previous
                // Windows instance; FIRST_PIPE_INSTANCE is intentionally kept.
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                if let Ok(pipe)=create(&name){next=Some(pipe);break}
            }
            match next{Some(pipe)=>server=pipe,None=>{eprintln!("Cicada local agent pipe restart unavailable");break}}
        }
    });Ok(())
}

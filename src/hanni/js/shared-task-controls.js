// Explicitly opt an existing personal native record into the configured exchange.
// Reuses its exact ID; creating a binding never starts an executor or human timer.
export function mountSharedTaskControls(host,{record,invoke,onShared=()=>{},operationId=()=>crypto.randomUUID()}){
 if(record?.source_type!=='note'||record.readonly||!(record.sphere==='personal'||String(record.tags||'').split(',').includes('task-sphere:personal')))return ()=>{};
 const id=String(record.source_id),key=`calendar_shared_binding_pending_v1:${id}`,doc=host.ownerDocument;
 const button=doc.createElement('button');button.type='button';button.textContent='Проверяем связь с Agent City…';button.disabled=true;
 const status=doc.createElement('p');status.setAttribute('role','status');
 const reconcile=doc.createElement('button');reconcile.type='button';reconcile.textContent='Сохранить конфликт в истории и перечитать связь';reconcile.hidden=true;
 host.append(button,status,reconcile);let disposed=false,pending=null,pendingRaw=null;
 const send=async input=>{const value=await invoke('shared_task_command',{input});if(value?.isError){const e=Error(value.code);e.status=value.status;throw e;}return value;};
 async function load(){
  try{
   pendingRaw=await invoke('get_ui_state',{key});pending=pendingRaw?JSON.parse(pendingRaw):null;
   if(pending&&(pending.command!=='share'||pending.arguments?.taskId!==id))throw Error('invalid_pending_binding');
   let bound=false;try{bound=!!(await send({operationId:operationId(),command:'get',arguments:{taskId:id}}))?.binding;}
   catch(e){if(e.status!==404)throw e;}
   if(disposed)return;button.disabled=bound&&!pending;button.textContent=pending?'Повторить подключение':bound?'Общая задача с Agent City':'Показать в Agent City';
   status.textContent=pending?'Ответ не получен. Повтор использует тот же ID операции.':bound?'Данные доступны настроенному обмену. Исполнение и таймер запускаются отдельно.':'Подключение сохранит исходный ID, описание и историю. Нужен настроенный обмен в Agent City.';
  }catch{if(!disposed){button.textContent='Связь с Agent City недоступна';button.disabled=true;status.textContent='Задача доступна как обычно. Повтори открытие, чтобы проверить связь.';}}
 }
 button.addEventListener('click',async()=>{
  button.disabled=true;
  try{
   if(!pending){const fresh=await invoke('get_calendar_task',{id});if(!Number.isSafeInteger(fresh?.version)||fresh.version<1)throw Error('revision_unavailable');
    pending={operationId:operationId(),command:'share',arguments:{taskId:id,expectedVersion:fresh.version}};
    const raw=JSON.stringify(pending);await invoke('set_ui_state',{key,value:raw,expectedValue:pendingRaw??null});pendingRaw=raw;
   }
   const receipt=await send(pending);if(receipt.operationId!==pending.operationId||receipt.acknowledged!==true||receipt.task?.id!==id)throw Error('unconfirmed_binding');
   await invoke('set_ui_state',{key,value:'',expectedValue:pendingRaw});pending=null;pendingRaw='';
   if(!disposed){button.textContent='Общая задача с Agent City';status.textContent='Подключено с исходным ID. Исполнение не запускалось.';onShared(receipt.task);}
  }catch(e){if(!disposed){button.disabled=false;button.textContent='Повторить подключение';reconcile.hidden=e.status!==409;status.textContent=e.status===409?'Задача изменилась. Черновик подключения сохранён; перечитай задачу перед новым решением.':'Подключение не подтверждено. Черновик сохранён для повтора.';}}
 });
 reconcile.addEventListener('click',async()=>{
  reconcile.disabled=true;
  try{const historyKey=key+':conflicts',raw=await invoke('get_ui_state',{key:historyKey}),history=raw?JSON.parse(raw):[];history.push(pending);
   await invoke('set_ui_state',{key:historyKey,value:JSON.stringify(history),expectedValue:raw??null});await invoke('set_ui_state',{key,value:'',expectedValue:pendingRaw});pending=null;pendingRaw='';reconcile.hidden=true;await load();
  }catch{if(!disposed)status.textContent='Не удалось сохранить конфликт. Исходный черновик сохранён.';}
  finally{reconcile.disabled=false;}
 });
 void load();return ()=>{disposed=true;button.remove();status.remove();reconcile.remove();};
}



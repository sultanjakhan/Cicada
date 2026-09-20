import { createCalendarDialog } from './calendar-dialog.js';

// A switch always names the work being paused. Reading/selecting a task never calls this.
export async function startCalendarExecution(invoke, task, document) {
  const active = await invoke('get_active_block', {});
  if (active?.source_type===task.source_type && String(active.source_id)===String(task.source_id)) return active.id;
  if (active) {
    let title='Текущая задача';
    if(active.source_type==='note')title=(await invoke('get_note',{id:String(active.source_id)}))?.title||title;
    else if(active.source_type==='schedule')title=(await invoke('get_schedules',{})).find(row=>String(row.id)===String(active.source_id))?.title||title;
    else if(active.source_type==='event')title=(await invoke('get_all_events',{})).find(row=>String(row.id)===String(active.source_id))?.title||title;
    const confirmed=await new Promise(resolve=>{
      let accepted=false;
      const dialog=createCalendarDialog({document,title:'Переключить занятие?',submitLabel:'Поставить на паузу и начать',onClose:()=>resolve(accepted)});
      const message=document.createElement('p');message.textContent=`«${title}» останется незавершённой. Начать «${task.title}»?`;dialog.body.append(message);
      dialog.form.addEventListener('submit',event=>{event.preventDefault();accepted=true;dialog.close();});dialog.open();
    });
    if(!confirmed)return null;
    const current=await invoke('get_active_block',{});
    if(current && Number(current.id)!==Number(active.id))throw Error('Текущая работа изменилась. Обнови экран и повтори переключение.');
    if(current)await invoke('pause_task_block',{blockId:Number(active.id)});
  }
  const id=await invoke('start_task_block',{sourceType:task.source_type,sourceId:String(task.source_id),failIfActive:true,completionDate:task.completion_date||task.date||localDay()});
  const win=document.defaultView;
  win.dispatchEvent(new win.Event('hanni:execution-started'));
  return id;
}
const localDay=()=>{const date=new Date();return`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;};

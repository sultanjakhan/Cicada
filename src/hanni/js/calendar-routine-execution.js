import { createCalendarDialog } from './calendar-dialog.js';
import { createRecurringStore, recurringSourceId, unfinishedRun } from './calendar-recurring-store.js';
import { startCalendarExecution } from './calendar-execution.js';
const openDialogs=new WeakMap();

export function openRecurringRun({document,invoke,id,date,start=false}) {
  if(openDialogs.has(document))return openDialogs.get(document);
  const win=document.defaultView,store=createRecurringStore(invoke);
  let disposed=false,busy=false,origin=date||store.today(),record=null,rows=[],current=null;
  const dialog=createCalendarDialog({document,title:'Выполнение рутины',onClose:()=>{disposed=true;win.removeEventListener('task-state-changed',onExternal);win.removeEventListener('hanni:calendar-refresh',onExternal);openDialogs.delete(document);}});
  dialog.modal.classList.add('calendar-routine-dialog');
  dialog.modal.querySelector('footer [data-dialog-close]').textContent='Закрыть';
  openDialogs.set(document,dialog);
  const notify=()=>{win.dispatchEvent(new win.Event('task-state-changed'));win.dispatchEvent(new win.Event('hanni:recurring-changed'));win.dispatchEvent(new win.Event('hanni:calendar-refresh'));};
  const button=(label,action)=>{const node=document.createElement('button');node.type='button';node.textContent=label;node.dataset.runAction=action;node.addEventListener('click',()=>void perform(action));return node;};
  function render(){
    dialog.body.replaceChildren();
    if(!record)return;
    dialog.modal.querySelector('h2').textContent=record.snapshot.title;
    const list=document.createElement('ol');list.className='calendar-routine-steps';
    current=record.run.steps.findIndex(step=>step.status==='pending');
    record.run.steps.forEach((step,index)=>{
      const row=rows.find(row=>String(row.id)===recurringSourceId(id,origin,index));
      const item=document.createElement('li'),title=document.createElement('span'),status=document.createElement('small');
      title.textContent=step.title;
      status.textContent=step.status==='done'?'Выполнено':step.status==='skipped'?'Пропущено':row?.is_active?'В работе':row?.has_work?'На паузе':index===current?'Следующий шаг':'Ожидает';
      item.append(title,status);if(index===current)item.setAttribute('aria-current','step');list.append(item);
    });
    dialog.body.append(list);
    if(current>=0){
      const row=rows.find(row=>String(row.id)===recurringSourceId(id,origin,current));
      const controls=document.createElement('div');controls.className='calendar-routine-controls';
      controls.append(button(row?.is_active?'Пауза':row?.has_work?'Продолжить':'Начать',row?.is_active?'pause':'start'));
      if(row?.has_work || row?.is_active)controls.append(button(record.run.steps.length>1?'Завершить шаг':'Завершить','finish'));
      controls.append(button('Пропустить шаг','skip'));dialog.body.append(controls);
    }else{
      const message=document.createElement('p');
      const done=record.run.steps.filter(step=>step.status==='done').length;
      message.textContent=`Выполнение закончено: ${done} из ${record.run.steps.length} ${done===1?'шага выполнен':'шагов выполнено'}.`;
      dialog.body.append(message);
    }
    dialog.setPending(busy);
  }
  async function refresh(){
    const state=await store.read();
    const run=state.days[origin]?.[id];
    record=run?.run?run:null;
    rows=await invoke('get_schedules',{});
    if(!disposed)render();
  }
  async function perform(action){
    if(busy||disposed)return;busy=true;dialog.setPending(true);dialog.showError('');
    try{
      await refresh();
      if(current<0)throw Error('Это выполнение уже закончено.');
      const sourceId=recurringSourceId(id,origin,current),row=rows.find(item=>String(item.id)===sourceId);
      if(action==='start')await startCalendarExecution(invoke,{source_type:'schedule',source_id:sourceId,title:row?.title||record.snapshot.title,completion_date:origin},document);
      else if(action==='skip')await invoke('skip_recurring_step',{sourceId});
      else{
        const active=await invoke('get_active_block',{});
        const blocks=await invoke('get_timeline_blocks',{date:origin});
        // A run can cross midnight; get_schedules exposes its latest block id/date.
        const blockId=row?.block_id ?? blocks.filter(block=>block.source_type==='schedule'&&String(block.source_id)===sourceId).at(-1)?.id;
        if(action==='pause'){
          if(active?.source_type!=='schedule'||String(active.source_id)!==sourceId)throw Error('Состояние изменилось. Обнови выполнение.');
          await invoke('pause_task_block',{blockId:Number(active.id)});
        }else{
          if(blockId==null)throw Error('Сначала начни этот шаг.');
          await invoke('finish_task_block',{blockId:Number(blockId)});
        }
      }
      notify();await refresh();
    }catch(error){dialog.showError(error?.message||String(error));}
    finally{busy=false;if(!disposed){dialog.setPending(false);}}
  }
  const onExternal=()=>{if(!busy&&!disposed)void refresh().catch(error=>dialog.showError(error?.message||String(error)));};
  win.addEventListener('task-state-changed',onExternal);win.addEventListener('hanni:calendar-refresh',onExternal);
  dialog.open();dialog.body.textContent='Загружаем выполнение…';
  void (async()=>{
    try{
      const state=await store.read(),existing=unfinishedRun(state,id);
      if(existing)origin=existing.date;
      if(!state.days[origin]?.[id]?.run){const result=await store.ensureRun(id,origin);origin=result.result.date;}
      await refresh();
      if(start&&!disposed)await perform('start');
    }catch(error){dialog.showError(error?.message||String(error));}
  })();
  return dialog;
}

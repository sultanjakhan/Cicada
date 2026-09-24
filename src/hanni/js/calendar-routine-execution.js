import { createCalendarDialog } from './calendar-dialog.js';
import { createRecurringStore, recurringSourceId, unfinishedRun } from './calendar-recurring-store.js';
import { startCalendarExecution, readActiveBlocks } from './calendar-execution.js';
const openDialogs=new WeakMap();

export function openRecurringRun({document,invoke,id,date,start=false}) {
  if(openDialogs.has(document))return openDialogs.get(document);
  const win=document.defaultView,store=createRecurringStore(invoke);
  let disposed=false,busy=false,origin=date||store.today(),record=null,rows=[],current=-1,readVersion=0;
  const dialog=createCalendarDialog({document,title:'Выполнение рутины',onClose:()=>{disposed=true;win.removeEventListener('task-state-changed',onExternal);win.removeEventListener('hanni:calendar-refresh',onExternal);openDialogs.delete(document);}});
  dialog.modal.classList.add('calendar-routine-dialog');
  dialog.modal.querySelector('footer [data-dialog-close]').textContent='Закрыть';
  openDialogs.set(document,dialog);
  const notify=()=>{win.dispatchEvent(new win.Event('task-state-changed'));win.dispatchEvent(new win.Event('hanni:recurring-changed'));win.dispatchEvent(new win.Event('hanni:calendar-refresh'));};
  const button=(label,action)=>{const expectedStep=current;const node=document.createElement('button');node.type='button';node.textContent=label;node.dataset.runAction=action;node.addEventListener('click',()=>void perform(action,expectedStep));return node;};
  function render(){
    const focused=dialog.body.contains(document.activeElement)?document.activeElement.dataset.runAction:null;
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
      message.textContent=`Выполнение закончено. Выполнено шагов: ${done} из ${record.run.steps.length}.`;
      dialog.body.append(message);
    }
    dialog.setPending(busy);
    if(focused&&!busy)dialog.body.querySelector(`[data-run-action="${focused}"]`)?.focus();
  }
  async function refresh(){
    const version=++readVersion;
    const [state,nextRows]=await Promise.all([store.read(),invoke('get_schedules',{})]);
    if(disposed||version!==readVersion)return false;
    const run=state.days[origin]?.[id];
    record=run?.run?run:null;rows=nextRows;
    current=record?record.run.steps.findIndex(step=>step.status==='pending'):-1;
    render();return true;
  }
  async function perform(action,expectedStep=current){
    if(busy||disposed)return;busy=true;dialog.setPending(true);dialog.showError('');
    try{
      if(!await refresh()||disposed)return;
      if(!record)throw Error('Выполнение больше недоступно. Закрой окно и обнови рутины.');
      if(current!==expectedStep)throw Error('Шаг уже изменился. Проверь текущее выполнение перед следующим действием.');
      if(current<0)throw Error('Это выполнение уже закончено.');
      const sourceId=recurringSourceId(id,origin,current),row=rows.find(item=>String(item.id)===sourceId);
      if(action==='start'){
        await startCalendarExecution(invoke,{source_type:'schedule',source_id:sourceId,title:row?.title||record.snapshot.title,completion_date:origin});
      }
      else if(action==='skip')await invoke('skip_recurring_step',{sourceId});
      else{
        // Other tasks may run beside this step; act only on this step's own block.
        const active=(await readActiveBlocks(invoke)).find(block=>block.source_type==='schedule'&&String(block.source_id)===sourceId);
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
    finally{busy=false;if(!disposed){
      dialog.setPending(false);
      if(dialog.error.hidden)(dialog.body.querySelector('[data-run-action]')||dialog.modal.querySelector('footer [data-dialog-close]'))?.focus();
    }}
  }
  const onExternal=()=>{if(!busy&&!disposed)void refresh().catch(error=>dialog.showError(error?.message||String(error)));};
  win.addEventListener('task-state-changed',onExternal);win.addEventListener('hanni:calendar-refresh',onExternal);
  dialog.open();dialog.body.textContent='Загружаем выполнение…';
  void (async()=>{
    try{
      const state=await store.read();
      if(disposed)return;
      if(!state.days[origin]?.[id]?.run){
        const existing=unfinishedRun(state,id);
        if(existing)origin=existing.date;
        else if(start){const result=await store.ensureRun(id,origin);origin=result.result.date;}
        else throw Error('Выполнение ещё не начато. Закрой окно и нажми «Начать» у рутины.');
      }
      await refresh();
      if(start&&!disposed)await perform('start');
    }catch(error){dialog.showError(error?.message||String(error));}
  })();
  return dialog;
}

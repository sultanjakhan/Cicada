import { createCalendarDialog } from './calendar-dialog.js';
import { createRecurringStore, recurringSourceId, unfinishedRun, availableGraphSteps } from './calendar-recurring-store.js';
import { startCalendarExecution, readActiveBlocks } from './calendar-execution.js';
const openDialogs=new WeakMap();

export function openRecurringRun({document,invoke,id,date,start=false,returnFocus}) {
  if(openDialogs.has(document))return openDialogs.get(document);
  const win=document.defaultView,store=createRecurringStore(invoke);
  let disposed=false,busy=false,origin=date||store.today(),record=null,rows=[],current=-1,readVersion=0;
  const dialog=createCalendarDialog({document,title:'Выполнение рутины',returnFocus,onClose:()=>{disposed=true;win.removeEventListener('task-state-changed',onExternal);win.removeEventListener('hanni:calendar-refresh',onExternal);openDialogs.delete(document);}});
  dialog.modal.classList.add('calendar-routine-dialog');
  dialog.modal.querySelector('footer [data-dialog-close]').textContent='Закрыть';
  openDialogs.set(document,dialog);
  const notify=()=>{win.dispatchEvent(new win.Event('task-state-changed'));win.dispatchEvent(new win.Event('hanni:recurring-changed'));win.dispatchEvent(new win.Event('hanni:calendar-refresh'));};
  const button=(label,action)=>{const expectedStep=current;const node=document.createElement('button');node.type='button';node.textContent=label;node.dataset.runAction=action;node.addEventListener('click',()=>void perform(action,expectedStep));return node;};
  const graph=()=>record?.snapshot?.mode==='graph';
  const available=()=>graph()?availableGraphSteps(record.snapshot,record.run):[];
  const scheduleRow=index=>rows.find(row=>String(row.id)===recurringSourceId(id,origin,index));
  function chooseCurrent(){
    if(!record)return;
    if(!graph()){current=record.run.steps.findIndex(step=>step.status==='pending');return;}
    const open=available();
    if(open.includes(current))return;
    const active=open.find(index=>scheduleRow(index)?.is_active);
    current=active??(open.length===1?open[0]:-1);
  }
  function render(){
    const focused=dialog.body.contains(document.activeElement)?document.activeElement.dataset.runAction:null,focusedStep=dialog.body.contains(document.activeElement)?document.activeElement.dataset.routineStep:null;
    dialog.body.replaceChildren();
    if(!record)return;
    dialog.modal.querySelector('h2').textContent=record.snapshot.title;
    const list=document.createElement('ol');list.className='calendar-routine-steps';
    chooseCurrent();
    record.run.steps.forEach((step,index)=>{
      const row=scheduleRow(index),isAvailable=graph()&&available().includes(index),dependencies=record.snapshot.steps?.[index]?.dependsOn||[];
      const item=document.createElement('li'),title=document.createElement('span'),status=document.createElement('small');
      title.textContent=step.title;
      const waitingFor=dependencies.filter(dependency=>!['done','skipped'].includes(record.run.steps[dependency]?.status));
      const graphStep=graph()?record.snapshot.steps[index]:null;
      const stepStatus=step.status==='done'?'Выполнено':step.status==='skipped'?'Пропущено':row?.is_active?'В работе':row?.has_work?'На паузе':graph()?(isAvailable?`${graphStep?.optional?'По желанию · ':''}${graphStep?.trackingMode==='check'?'Готово':'Доступен'}`:`После: ${waitingFor.map(dependency=>record.snapshot.steps[dependency]?.title||'шага').join(', ')}`):index===current?'Следующий шаг':'Ожидает';
      status.textContent=stepStatus;
      if(graph()){
        const choice=document.createElement('button');choice.type='button';choice.className='calendar-routine-step-choice';choice.dataset.routineStep=String(index);choice.disabled=!isAvailable;choice.setAttribute('aria-pressed',String(index===current));
        choice.append(title,status);choice.addEventListener('click',()=>{if(!busy&&isAvailable){current=index;render();}});item.append(choice);
      }else item.append(title,status);
      if(index===current)item.setAttribute('aria-current','step');list.append(item);
    });
    dialog.body.append(list);
    if(current>=0&&(graph()?available().includes(current):true)){
      const row=scheduleRow(current);
      const controls=document.createElement('div');controls.className='calendar-routine-controls';
      if(graph()&&record.snapshot.steps[current]?.trackingMode==='check')controls.append(button('Готово','complete'));
      else controls.append(button(row?.is_active?'Пауза':row?.has_work?'Продолжить':'Начать',row?.is_active?'pause':'start'));
      if((row?.has_work || row?.is_active)&&!(graph()&&record.snapshot.steps[current]?.trackingMode==='check'))controls.append(button(!graph()&&record.run.steps.length===1?'Завершить':'Завершить шаг','finish'));
      controls.append(button('Пропустить шаг','skip'));dialog.body.append(controls);
    }else{
      const message=document.createElement('p');
      const done=record.run.steps.filter(step=>step.status==='done').length;
      const open=graph()?available():[];
      message.textContent=graph()&&open.length?`Выбери доступный шаг. Выполнено: ${done} из ${record.run.steps.length}.`: `Выполнение закончено. Выполнено шагов: ${done} из ${record.run.steps.length}.`;
      dialog.body.append(message);
    }
    dialog.setPending(busy);
    if(focused&&!busy)dialog.body.querySelector(`[data-run-action="${focused}"]`)?.focus();
    else if(focusedStep&&!busy)dialog.body.querySelector(`[data-routine-step="${focusedStep}"]`)?.focus();
  }
  async function refresh(){
    const version=++readVersion;
    const [state,nextRows]=await Promise.all([store.read(),invoke('get_schedules',{})]);
    if(disposed||version!==readVersion)return false;
    if(!Array.isArray(nextRows))throw Error('Не удалось прочитать шаги выполнения.');
    const run=state.days[origin]?.[id];
    record=run?.run?run:null;rows=nextRows;
    if(!record)current=-1;else chooseCurrent();
    render();return true;
  }
  async function perform(action,expectedStep=current){
    if(busy||disposed)return;busy=true;dialog.setPending(true);dialog.showError('');
    try{
      if(!await refresh()||disposed)return;
      if(!record)throw Error('Выполнение больше недоступно. Закрой окно и обнови рутины.');
      if(graph()&&!available().includes(expectedStep))throw Error('Шаг больше недоступен. Проверь зависимости и обнови выполнение.');
      if(current!==expectedStep)throw Error('Шаг уже изменился. Проверь текущее выполнение перед следующим действием.');
      if(current<0)throw Error('Это выполнение уже закончено.');
      const sourceId=recurringSourceId(id,origin,current),row=rows.find(item=>String(item.id)===sourceId);
      if(action==='complete'){
        if(!graph()||record.snapshot.steps[current]?.trackingMode!=='check')throw Error('Этот шаг нельзя отметить без таймера.');
        await invoke('complete_recurring_step',{sourceId});
      }
      else if(action==='start'){
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
      if(start&&!disposed){
        const needsChoice=graph()&&available().length>1;
        const selectedActive=current>=0&&scheduleRow(current)?.is_active;
        const checkStep=graph()&&current>=0&&record.snapshot.steps[current]?.trackingMode==='check';
        if(!needsChoice&&!selectedActive&&!checkStep&&current>=0)await perform('start');
      }
    }catch(error){dialog.showError(error?.message||String(error));}
  })();
  return dialog;
}

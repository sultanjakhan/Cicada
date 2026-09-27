import { createCalendarDialog } from './calendar-dialog.js';
import { createRecurringStore, recurringSourceId, unfinishedRun, availableGraphSteps } from './calendar-recurring-store.js';
import { startCalendarExecution, readActiveBlocks } from './calendar-execution.js';
const openDialogs=new WeakMap();

export function openRecurringRun({document,invoke,id,date,start=false,returnFocus}) {
  if(openDialogs.has(document))return openDialogs.get(document);
  const win=document.defaultView,store=createRecurringStore(invoke);
  let disposed=false,busy=false,origin=date||store.today(),record=null,rows=[],activeBlocks=[],current=-1,readVersion=0,rendered='',clockTimer=null;
  const dialog=createCalendarDialog({document,title:'Выполнение рутины',returnFocus,onClose:()=>{disposed=true;win.clearInterval(clockTimer);win.removeEventListener('task-state-changed',onExternal);win.removeEventListener('hanni:calendar-refresh',onExternal);openDialogs.delete(document);}});
  dialog.modal.classList.add('calendar-routine-dialog');
  dialog.modal.querySelector('footer [data-dialog-close]').textContent='Закрыть';
  openDialogs.set(document,dialog);
  const notify=()=>{win.dispatchEvent(new win.Event('task-state-changed'));win.dispatchEvent(new win.Event('hanni:recurring-changed'));win.dispatchEvent(new win.Event('hanni:calendar-refresh'));};
  const button=(label,action,index=current)=>{const node=document.createElement('button');node.type='button';node.textContent=label;node.setAttribute('aria-label',`${label}: ${record.run.steps[index].title}`);node.dataset.runAction=action;node.dataset.runStep=String(index);node.addEventListener('click',()=>{if(busy)return;current=index;void perform(action,index);});return node;};
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
    if(!record){dialog.body.textContent='Выполнение недоступно. Закрой окно и выбери рутину заново.';rendered='';return;}
    chooseCurrent();
    const signature=JSON.stringify([record,rows.map(row=>[row.id,row.is_active,row.has_work,row.actual_seconds]),current]);
    if(signature===rendered){tick();return;}
    const focused=dialog.body.contains(document.activeElement)?document.activeElement.dataset.runAction:null,focusedStep=document.activeElement?.dataset.runStep;
    const expanded=dialog.body.querySelector('[data-run-plan]')?.open||false;
    dialog.body.replaceChildren();rendered=signature;
    dialog.modal.querySelector('h2').textContent=record.snapshot.title;
    const done=record.run.steps.filter(step=>step.status==='done').length,skipped=record.run.steps.filter(step=>step.status==='skipped').length;
    const progress=document.createElement('p');progress.className='calendar-run-progress';progress.textContent=`Выполнено ${done} из ${record.run.steps.length}${skipped?` · пропущено ${skipped}`:''}${origin!==store.today()?` · Начато ${new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'long'}).format(new Date(origin+'T12:00:00'))}`:''}`;dialog.body.append(progress);
    const ready=graph()?available():current>=0?[current]:[];
    const next=document.createElement('section');next.className='calendar-run-ready';next.dataset.runReady='';
    const heading=document.createElement('h3');heading.textContent=ready.length>1?'Выбери следующий шаг':ready.length?'Текущий шаг':'Рутина завершена';next.append(heading);
    if(ready.length>1){const hint=document.createElement('p');hint.textContent='Эти шаги доступны сейчас. Выбери удобный порядок.';next.append(hint);}
    for(const index of ready){
      const step=record.run.steps[index],row=scheduleRow(index),stepConfig=record.snapshot.steps?.[index],check=graph()&&stepConfig?.trackingMode==='check';
      const card=document.createElement('article');card.className='calendar-run-step';card.dataset.runStepCard=String(index);if(index===current)card.setAttribute('aria-current','step');
      const title=document.createElement('strong'),name=document.createElement('span');name.textContent=step.title;title.append(name);card.append(title);
      const status=document.createElement('p');status.className='calendar-run-step__status';status.textContent=[row?.is_active?'В работе':row?.has_work?'На паузе':check?'Отметка без таймера':'С учётом времени',stepConfig?.optional?'По желанию':''].filter(Boolean).join(' · ');card.append(status);
      if(!check){const time=document.createElement('span');time.dataset.runClock=String(index);time.className='calendar-run-clock';status.append(' · ',time);}
      const controls=document.createElement('div');controls.className='calendar-run-actions';
      const primary=check?button('Отметить шаг','complete',index):button(row?.is_active?'Пауза':row?.has_work?'Продолжить':'Начать шаг',row?.is_active?'pause':'start',index);
      primary.dataset.routineStep=String(index);primary.className='calendar-run-primary';controls.append(primary);
      if((row?.has_work||row?.is_active)&&!check)controls.append(button(!graph()&&record.run.steps.length===1?'Завершить':'Завершить шаг','finish',index));
      const skip=button('Пропустить','skip',index);skip.className='calendar-run-skip';controls.append(skip);card.append(controls);next.append(card);
    }
    if(!ready.length){const message=document.createElement('p');message.textContent='Все шаги выполнены или пропущены. Можно закрыть окно.';next.append(message);}
    dialog.body.append(next);
    const plan=document.createElement('details');plan.dataset.runPlan='';plan.className='calendar-run-plan';plan.open=expanded;
    const summary=document.createElement('summary');summary.textContent=`Все шаги · ${record.run.steps.length}`;plan.append(summary);
    const list=document.createElement('ol');list.className='calendar-routine-steps';
    record.run.steps.forEach((step,index)=>{
      const row=scheduleRow(index),isAvailable=graph()&&available().includes(index),dependencies=record.snapshot.steps?.[index]?.dependsOn||[];
      const item=document.createElement('li'),title=document.createElement('span'),status=document.createElement('small');item.dataset.planStep=String(index);
      title.textContent=step.title;
      const waitingFor=dependencies.filter(dependency=>!['done','skipped'].includes(record.run.steps[dependency]?.status));
      const graphStep=graph()?record.snapshot.steps[index]:null;
      const stepStatus=step.status==='done'?'Выполнено':step.status==='skipped'?'Пропущено':row?.is_active?'В работе':row?.has_work?'На паузе':graph()?(isAvailable?`${graphStep?.optional?'По желанию · ':''}${graphStep?.trackingMode==='check'?'Можно отметить':'Доступен'}`:`После: ${waitingFor.map(dependency=>record.snapshot.steps[dependency]?.title||'шага').join(', ')}`):index===current?'Следующий шаг':'Ожидает';
      status.textContent=stepStatus;
      item.append(title,status);list.append(item);
    });
    plan.append(list);dialog.body.append(plan);tick();
    dialog.setPending(busy);
    if(focused&&!busy)dialog.body.querySelector(`[data-run-step="${focusedStep}"][data-run-action="${focused}"]`)?.focus({preventScroll:true});
  }
  function tick(){
    dialog.body.querySelectorAll('[data-run-clock]').forEach(node=>{
      const index=Number(node.dataset.runClock),row=scheduleRow(index),block=activeBlocks.find(value=>value.source_type==='schedule'&&String(value.source_id)===recurringSourceId(id,origin,index));
      const elapsed=block?Math.max(0,Math.floor((Date.now()-new Date(`${block.date}T${block.start_time}`).getTime())/1000)):0;
      const seconds=Math.max(0,Number(row?.actual_seconds)||0)+(Number.isFinite(elapsed)?elapsed:0);
      node.textContent=`${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;
    });
  }
  async function refresh(){
    const version=++readVersion;
    const [state,nextRows,nextActive]=await Promise.all([store.read(),invoke('get_schedules',{}),readActiveBlocks(invoke)]);
    if(disposed||version!==readVersion)return false;
    if(!Array.isArray(nextRows))throw Error('Не удалось прочитать шаги выполнения.');
    const run=state.days[origin]?.[id];
    record=run?.run?run:null;rows=nextRows.filter(row=>record?.run.steps.some((_step,index)=>String(row.id)===recurringSourceId(id,origin,index)));activeBlocks=nextActive;
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
      if(dialog.error.hidden)(dialog.body.querySelector(`[data-run-step="${expectedStep}"][data-run-action]`)||dialog.body.querySelector('[data-run-action]')||dialog.modal.querySelector('footer [data-dialog-close]'))?.focus({preventScroll:true});
    }}
  }
  const reportReadError=error=>{if(!disposed){dialog.showError(error?.message||String(error));dialog.retry.textContent='Повторить загрузку';dialog.retry.hidden=false;}};
  const onExternal=()=>{if(!busy&&!disposed)void refresh().catch(reportReadError);};
  win.addEventListener('task-state-changed',onExternal);win.addEventListener('hanni:calendar-refresh',onExternal);
  dialog.open();dialog.body.textContent='Загружаем выполнение…';clockTimer=win.setInterval(tick,1000);
  async function initialize(autoStart){
    dialog.retry.disabled=true;dialog.showError('');
    try{
      const state=await store.read();
      if(disposed)return;
      let created=false;
      if(!state.days[origin]?.[id]?.run){
        const existing=unfinishedRun(state,id);
        if(existing)origin=existing.date;
        else if(start){const result=await store.ensureRun(id,origin);origin=result.result.date;created=true;}
        else throw Error('Выполнение ещё не начато. Закрой окно и нажми «Начать» у рутины.');
      }
      await refresh();
      dialog.retry.hidden=true;
      if(autoStart&&!disposed){
        const needsChoice=graph()&&available().length>1;
        const selectedActive=current>=0&&scheduleRow(current)?.is_active;
        const checkStep=graph()&&current>=0&&record.snapshot.steps[current]?.trackingMode==='check';
        if(!needsChoice&&!selectedActive&&!checkStep&&current>=0)await perform('start');
      }
      if(created&&!disposed)notify();
    }catch(error){reportReadError(error);}
    finally{if(!disposed)dialog.retry.disabled=false;}
  }
  dialog.retry.onclick=()=>{if(!dialog.retry.disabled)void initialize(false);};
  void initialize(start);
  return dialog;
}

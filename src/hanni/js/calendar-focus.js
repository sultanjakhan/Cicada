import { mountCalendarInProgress } from './calendar-in-progress.js';

// Device-local selection only; execution stays in the existing native timeline.
export const FOCUS_KEY = 'cicada_selected_work_v1';
export function readWorkSelection(storage) {
  try {
    const task = JSON.parse(storage.getItem(FOCUS_KEY));
    if (task && ['note','event','schedule'].includes(task.source_type) && typeof task.source_id === 'string' && task.source_id.length <= 1024) return task;
  } catch { /* A corrupt preference never changes work. */ }
  return null;
}
export function mountCalendarFocus(element, dependencies) {
  const doc=element.ownerDocument, win=doc.defaultView, storage=dependencies.storage || win.localStorage;
  let selected=readWorkSelection(storage), compact=false, busy=false, disposed=false, widget;
  const routineOf=task=>{try{return task?.source_type==='schedule' ? JSON.parse(task.source_id).slice(0,2) : null;}catch{return null;}};
  let preferredRoutine=routineOf(selected);
  element.classList.add('calendar-focus');
  element.innerHTML='<div class="calendar-focus__tools"><span>Сейчас</span><button type="button" data-focus-expand hidden>Развернуть</button></div><div data-focus-work></div><p class="calendar-focus__error" role="alert" hidden></p>';
  const expand=element.querySelector('[data-focus-expand]'), error=element.querySelector('[role="alert"]');
  const root=doc.documentElement, button=dependencies.compactButton;
  const updateVisibility=()=>{
    element.hidden=!compact&&!selected;
    dependencies.onModeChange?.(compact,Boolean(selected));
  };
  const applyStatus=status=>{
    compact=status.compact===true;
    root.classList.toggle('calendar-compact-mode',compact);expand.hidden=!compact;
    if(button){button.hidden=!status.supported;button.setAttribute('aria-pressed',String(compact));}
    updateVisibility();
  };
  const fail=err=>{error.textContent=typeof err==='string'?err:err?.message || 'Не удалось изменить режим окна.';error.hidden=false;};
  async function setCompact(next) {
    if(disposed||busy)return false;
    if(next && doc.querySelector('.modal-overlay, dialog[open]')) {fail('Сначала закрой открытую форму.');return false;}
    busy=true;expand.disabled=true;if(button)button.disabled=true;error.hidden=true;
    try {
      const status=await dependencies.invoke('set_compact_window',{compact:next});
      if(!disposed){applyStatus(status);if(next)expand.focus({preventScroll:true});else button?.focus({preventScroll:true});}
      return true;
    }catch(err){
      if(!disposed){fail(err);try{applyStatus(await dependencies.invoke('get_compact_window_state'));}catch{}}
      return false;
    }finally{busy=false;if(!disposed){expand.disabled=false;if(button)button.disabled=false;}}
  }
  const ensureExpanded=async()=>!compact || await setCompact(false);
  function setSelectedTask(task) {
    // Opening the recommendation picker must not erase paused focus.
    if(!task)return;
    selected={source_type:task.source_type,source_id:String(task.source_id)};
    preferredRoutine=routineOf(selected);
    try{storage.setItem(FOCUS_KEY,JSON.stringify(selected));}catch{}
    updateVisibility();
    widget?.setSelectedTask(selected);
  }
  widget=mountCalendarInProgress(element.querySelector('[data-focus-work]'),{
    ...dependencies,singleSelection:true,selectedTask:selected,embedded:true,
    hideWhenEmpty:false,title:'Выбранная задача',
    openTask:async(...args)=>{if(await ensureExpanded())dependencies.openTask?.(...args);},
    openLauncher:async(...args)=>{if(await ensureExpanded())dependencies.openLauncher?.(...args);},
    onRowsSnapshot:rows=>{
      if(selected && rows.some(row=>row.key===`${selected.source_type}:${selected.source_id}`))return;
      selected=null;try{storage.removeItem(FOCUS_KEY);}catch{}
      const sameRun=row=>JSON.stringify(routineOf(row.record))===JSON.stringify(preferredRoutine);
      // A new routine may still be saving its first block. Keep that explicit
      // choice while it loads instead of falling back to another running task.
      const active=preferredRoutine ? rows.find(row=>sameRun(row)&&row.running) || rows.find(sameRun) : rows.find(row=>row.running);
      if(active)setSelectedTask(active.record);else {widget?.setSelectedTask(null);updateVisibility();}
    },
  });
  const toggle=()=>void setCompact(!compact);
  button?.addEventListener('click',toggle);expand.onclick=()=>void setCompact(false);
  void dependencies.invoke('get_compact_window_state').then(status=>{if(!disposed)applyStatus(status);}).catch(()=>{if(!disposed&&button)button.hidden=true;});
  const dispose=()=>{disposed=true;widget();button?.removeEventListener('click',toggle);};
  dispose.setSelectedTask=setSelectedTask;
  dispose.setSelectedRoutine=options=>{
    if(!options?.id)return;
    selected=null;preferredRoutine=[options.id,options.date];
    try{storage.removeItem(FOCUS_KEY);}catch{}
    updateVisibility();
    widget.setSelectedTask(null);void widget.refresh();
  };
  dispose.getSelection=()=>selected;dispose.ensureExpanded=ensureExpanded;
  return dispose;
}

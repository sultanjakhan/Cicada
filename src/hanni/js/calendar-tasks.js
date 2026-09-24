import { renderTaskImportance } from './task-importance.js';
import { ICONS } from './icons.js';
import { TASK_SPHERES, sphereLabel, isInstantTask, taskTime, compareTaskTime } from './task-model.js';

const taskKey = row => `${row.source_type}:${row.source_id}`;
const closed = row => row.completed || ['done', 'skipped', 'missed'].includes(row.status_extra);
const dayOf = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const shiftDay = (day, delta) => { const date = new Date(`${day}T12:00:00`); date.setDate(date.getDate() + delta); return dayOf(date); };
// Active tasks are grouped by how urgent their planned day is; closed tasks keep one group.
const GROUPS = [['overdue','Просрочено'],['today','Сегодня'],['soon','Скоро'],['undated','Без даты'],['completed','Завершённые']];
const groupOf = (row, today) => closed(row) ? 'completed' : !row.date ? 'undated' : row.date < today ? 'overdue' : row.date === today ? 'today' : 'soon';
const groupIndex = (row, today) => GROUPS.findIndex(([id]) => id === groupOf(row, today));
const EMPTY = { search:'Ничего не нашлось. Измени поиск, цель или сферу.', completed:'Завершённых задач пока нет.', undated:'Все задачи распределены по дням.', today:'На сегодня задач нет.', active:'Задач пока нет. Добавь первую через «Создать».' };
const MORE_ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3.5" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="12.5" cy="8" r="1.3"/></svg>';
const SEARCH_ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/></svg>';
let sequence = 0;

export function mountCalendarTasks(host, dependencies) {
  const { invoke, openTask, editDate, mountMenu, executeAction, notifyChange } = dependencies;
  const doc = host.ownerDocument, win = doc.defaultView;
  const state = dependencies.state || { filter:'active', search:'', goal:'', sphere:'', page:0 };
  state.sphere ??= '';
  const prefix = `calendar-tasks-${++sequence}`;
  let rows = [], goals = [], links = [], ready = false, disposed = false, revision = 0, busy = false, queued = false, feedback = '';
  let today = dayOf(new Date());
  host.classList.add('calendar-tasks');
  host.innerHTML = `<section aria-labelledby="${prefix}-title"><div class="ct-heading"><h2 id="${prefix}-title" tabindex="-1">Задачи <span data-tasks-count></span></h2></div>
    <div class="ct-toolbar"><div class="ct-filters" role="group" aria-label="Какие задачи показать">${[['active','Активные'],['today','Сегодня'],['undated','Без даты'],['completed','Завершённые']].map(([id,label])=>`<button type="button" data-tasks-filter="${id}" aria-pressed="false">${label}</button>`).join('')}</div>
    <div class="ct-search-row"><label class="ct-search"><span class="ct-search-icon">${SEARCH_ICON}</span><input type="search" data-tasks-search placeholder="Найти задачу" aria-label="Найти задачу"></label><span class="ct-select"><select data-tasks-goal aria-label="Фильтр по цели"><option value="">Любая цель</option></select></span><span class="ct-select ct-select--sphere"><select data-tasks-sphere aria-label="Фильтр по сфере"><option value="">Любая сфера</option><option value="none">Без сферы</option>${TASK_SPHERES.map(([id,label])=>`<option value="${id}">${label}</option>`).join('')}</select></span></div></div>
    <p data-tasks-message role="status" aria-live="polite"></p><button type="button" data-tasks-retry hidden>Повторить загрузку</button>
    <div data-tasks-list></div><div class="ct-pages" data-tasks-pages hidden><button type="button" data-tasks-prev>Назад</button><span data-tasks-page></span><button type="button" data-tasks-next>Далее</button></div></section>`;
  const q = name => host.querySelector(`[data-tasks-${name}]`);
  const heading = host.querySelector('h2'), message = q('message'), list = q('list'), search = q('search'), goalFilter = q('goal'), sphereFilter = q('sphere');
  search.value = state.search || '';
  if(!['', 'none', ...TASK_SPHERES.map(([id])=>id)].includes(state.sphere))state.sphere='';
  sphereFilter.value = state.sphere;
  const node = (tag, cls, text) => { const el = doc.createElement(tag); if(cls)el.className=cls; if(text!=null)el.textContent=text; return el; };
  const control = (cls,text,action) => { const el=node('button',cls,text);el.type='button';el.addEventListener('click',action);return el; };
  const findButton = (id, action='open') => [...host.querySelectorAll('[data-task-control]')].find(el => el.dataset.taskId === id && el.dataset.taskControl === action);
  const restore = (id, action='open') => { if(!disposed && host.isConnected)(findButton(id,action)||heading).focus({preventScroll:true}); };
  const goalFor = row => links.find(link=>taskKey(link)===taskKey(row))?.goal_id;
  const goalParts = id => { const parts=[], seen=new Set();let goal=goals.find(g=>String(g.id)===String(id));while(goal&&!seen.has(String(goal.id))){seen.add(String(goal.id));parts.unshift(goal.title);goal=goals.find(g=>String(g.id)===String(goal.parent_goal_id));}return parts; };
  const goalPath = id => goalParts(id).join(' / ');
  function matchesGoal(row) {
    const id=goalFor(row); if(!state.goal)return true;if(state.goal==='none')return id==null;
    const seen=new Set();let value=id;
    while(value!=null&&!seen.has(String(value))){if(String(value)===state.goal)return true;seen.add(String(value));value=goals.find(g=>String(g.id)===String(value))?.parent_goal_id;}
    return false;
  }
  const matchesSphere = row => !state.sphere || (state.sphere==='none' ? !sphereLabel(row.sphere) : row.sphere===state.sphere);
  const formatDate = (date, options) => new Intl.DateTimeFormat('ru',{...options,...(date.slice(0,4)!==today.slice(0,4)?{year:'numeric'}:{})}).format(new Date(`${date}T12:00:00`));
  const dateLabel = date => !date?'Без даты':date===today?'Сегодня':date===shiftDay(today,1)?'Завтра':date===shiftDay(today,-1)?'Вчера':formatDate(date,{day:'numeric',month:'short'});
  function effort(row) {
    const planned=!isInstantTask(row)&&Number(row.duration_minutes)>0?Number(row.duration_minutes):0, actual=Number(row.actual_minutes)>0?Number(row.actual_minutes):0;
    return { text: planned&&actual?`${planned} мин · факт ${actual}`:planned?`${planned} мин`:actual?`факт ${actual} мин`:'', hint:[planned&&`Оценка: ${planned} мин`,actual&&`Учтено: ${actual} мин`].filter(Boolean).join(', ') };
  }
  function renderRow(row) {
    const id=taskKey(row), done=closed(row), overdue=!done&&!!row.date&&row.date<today, running=!done&&!!row.is_active;
    const item=node('li','ct-row');item.dataset.contextRecord=id;item.classList.toggle('is-running',running);item.classList.toggle('is-overdue',overdue);item.classList.toggle('is-done',done);
    const complete=control('ct-complete',done?'✓':'',()=>void finish(row));complete.disabled=busy||done;complete.setAttribute('aria-label',`${done?'Завершена':'Завершить'}: ${row.title}`);if(!done)complete.title='Завершить';
    const title=control('ct-title',row.title,()=>openTask(row,()=>restore(id)));title.title=row.title;
    const meta=node('span','ct-meta');
    if(running)meta.append(node('span','ct-status ct-status--running','В работе'));else if(!done&&row.has_work)meta.append(node('span','ct-status','На паузе'));
    const instant=isInstantTask(row), time=taskTime(row), sphere=sphereLabel(row.sphere);
    if(instant){const kind=node('span','ct-kind','Моментальная');kind.title='Отмечается одним нажатием, без таймера';meta.append(kind);}
    const parts=goalParts(goalFor(row));
    if(parts.length){const goal=node('span','ct-goal',parts.at(-1));goal.title=parts.join(' / ');meta.append(goal);}
    const work=effort(row);if(work.text){const estimate=node('span','ct-estimate',work.text);estimate.title=work.hint;meta.append(estimate);}
    const date=control('ct-date',time?`${dateLabel(row.date)}, ${time}`:dateLabel(row.date),()=>editDate(row,()=>restore(id,'date')));date.disabled=busy;date.classList.toggle('is-overdue',overdue);date.classList.toggle('is-empty',!row.date);
    date.title=row.date?`${formatDate(row.date,{day:'numeric',month:'long',weekday:'short'})}${time?`, ${time}`:''}${overdue?' · просрочено':''} — изменить дату`:'Назначить дату';
    if(overdue)date.setAttribute('aria-label',`${date.textContent}, просрочено. Изменить дату`);
    meta.append(date);
    if(sphere){const label=node('span','ct-sphere',sphere);label.title=`Сфера: ${sphere}`;meta.append(label);}
    renderTaskImportance(doc,meta,row,item);
    const content=node('div','ct-content');content.append(title,meta);
    const actions=node('div','ct-actions');
    if(!done&&(!instant||row.is_active)){
      const label=row.is_active?'Пауза':row.has_work||row.actual_minutes>0?'Продолжить':'Начать';
      const run=control('ct-run ct-icon-button',null,()=>void finish(row,row.is_active?'pause':'start'));
      const glyph=node('span','ct-glyph');glyph.setAttribute('aria-hidden','true');glyph.innerHTML=ICONS[row.is_active?'pause':'play'];
      run.append(glyph,node('span','ct-visually-hidden',label));run.classList.toggle('is-running',running);
      run.disabled=busy;run.dataset.taskId=id;run.dataset.taskControl='execute';run.title=label;run.setAttribute('aria-label',`${label}: ${row.title}`);actions.append(run);
    }
    const more=control('ct-more ct-icon-button',null,()=>{});more.innerHTML=MORE_ICON;more.dataset.recordMenu='';more.title='Действия';more.setAttribute('aria-label',`Действия: ${row.title}`);more.setAttribute('aria-haspopup','menu');more.setAttribute('aria-expanded','false');more.disabled=busy;
    actions.append(more);
    for(const [button,action] of [[title,'open'],[date,'date'],[more,'menu'],[complete,'finish']]){button.dataset.taskId=id;button.dataset.taskControl=action;}
    item.append(complete,content,actions);
    return item;
  }
  function render() {
    if(disposed||!ready)return;
    const focused=doc.activeElement, focusId=focused?.dataset.taskId, focusAction=focused?.dataset.taskControl;
    const query=state.search.trim().toLocaleLowerCase('ru');
    const eligible=rows.filter(row=>(state.filter==='completed'?closed(row):!closed(row))&&(state.filter!=='today'||row.date===today)&&(state.filter!=='undated'||!row.date));
    const visible=eligible.filter(row=>matchesGoal(row)&&matchesSphere(row)&&`${row.title} ${goalPath(goalFor(row))}`.toLocaleLowerCase('ru').includes(query)).sort((a,b)=>groupIndex(a,today)-groupIndex(b,today)||Number(!!b.is_active)-Number(!!a.is_active)||(Number(b.priority)||0)-(Number(a.priority)||0)||(a.date||'9999').localeCompare(b.date||'9999')||compareTaskTime(a,b)||a.title.localeCompare(b.title,'ru')||taskKey(a).localeCompare(taskKey(b)));
    q('count').textContent=String(visible.length);
    host.querySelectorAll('[data-tasks-filter]').forEach(el=>el.setAttribute('aria-pressed',String(el.dataset.tasksFilter===state.filter)));
    state.page=Math.max(0,Math.min(state.page||0,Math.ceil(visible.length/50)-1));
    const totals=new Map();for(const row of visible){const id=groupOf(row,today);totals.set(id,(totals.get(id)||0)+1);}
    // Only Active mixes several groups; the other filters already name their single group.
    const grouped=state.filter==='active';
    list.replaceChildren();let lastGroup=null, ul;
    for(const row of visible.slice(state.page*50,(state.page+1)*50)) {
      const currentGroup=groupOf(row,today);
      if(currentGroup!==lastGroup){
        if(grouped){const [,label]=GROUPS.find(([id])=>id===currentGroup);const title=node('h3',`ct-group ct-group--${currentGroup}`);title.dataset.tasksGroup=currentGroup;title.setAttribute('aria-label',`${label}, ${totals.get(currentGroup)}`);title.append(node('span','ct-group-label',label),node('span','ct-group-count',String(totals.get(currentGroup))));list.append(title);}
        ul=node('ul','ct-list');list.append(ul);lastGroup=currentGroup;
      }
      ul.append(renderRow(row));
    }
    if(!visible.length)list.append(node('p','ct-empty',query||state.goal||state.sphere?EMPTY.search:EMPTY[state.filter]||EMPTY.active));
    q('pages').hidden=visible.length<=50;q('prev').disabled=state.page===0;q('next').disabled=(state.page+1)*50>=visible.length;
    q('page').textContent=`${state.page*50+1}–${Math.min((state.page+1)*50,visible.length)} из ${visible.length}`;
    if(focusId&&!focused.isConnected)restore(focusId,focusAction);
  }
  async function refresh(canCommit=null) {
    if(disposed||busy||canCommit&&!canCommit())return;
    const request=++revision;host.setAttribute('aria-busy','true');if(!ready)message.textContent='Загружаем задачи…';
    try{
      const result=await Promise.all([invoke('get_calendar_tasks',{includeCompleted:true}),invoke('get_goals',{tabName:null}),invoke('get_calendar_task_goals')]);
      if(disposed||request!==revision||canCommit&&!canCommit())return;
      if(result.some(value=>!Array.isArray(value)))throw new Error('Invalid task response');
      rows=[...new Map(result[0].filter(row=>row.source_type==='note'&&!row.readonly&&!row.archived).map(row=>[taskKey(row),row])).values()];goals=result[1];links=result[2];ready=true;today=dayOf(new Date());
      goalFilter.replaceChildren(new win.Option('Любая цель',''),new win.Option('Без цели','none'),...goals.map(goal=>new win.Option(goalPath(goal.id),String(goal.id))));
      if(state.goal&&!['none',...goals.map(goal=>String(goal.id))].includes(state.goal))state.goal='';goalFilter.value=state.goal;
      message.textContent=feedback;q('retry').hidden=true;render();
    }catch{if(!disposed&&request===revision){message.textContent=ready?'Не удалось обновить задачи. Показан предыдущий список.':'Не удалось загрузить задачи. Это не означает, что список пуст.';q('retry').hidden=false;}}
    finally{if(!disposed&&request===revision)host.removeAttribute('aria-busy');}
  }
  async function finish(row,action='finish'){
    if(busy||disposed)return;busy=true;revision++;feedback='';message.textContent='';render();
    try{const result=await executeAction(row,action);if(result===false)return;notifyChange();busy=false;await refresh();if(!disposed){feedback={start:'Задача в работе.',pause:'Задача на паузе.',finish:'Задача завершена.'}[action];message.textContent=feedback;message.setAttribute('role','status');restore(taskKey(row),action==='finish'?'open':'execute');}}
    catch(error){if(error?.refreshRequired)notifyChange();busy=false;await refresh();if(!disposed){feedback=error?.message||'Не удалось выполнить действие.';message.textContent=feedback;message.setAttribute('role','alert');}}
    finally{busy=false;render();}
  }
  const disposeMenu=mountMenu?.(host,{getRecord:item=>rows.find(row=>taskKey(row)===item.dataset.contextRecord),restoreFocus:(item,trigger)=>restore(item.dataset.contextRecord,'recordMenu' in trigger.dataset?'menu':'open')});
  host.querySelectorAll('[data-tasks-filter]').forEach(el=>el.addEventListener('click',()=>{state.filter=el.dataset.tasksFilter;state.page=0;render();}));
  search.addEventListener('input',()=>{state.search=search.value;state.page=0;render();});goalFilter.addEventListener('change',()=>{state.goal=goalFilter.value;state.page=0;render();});
  sphereFilter.addEventListener('change',()=>{state.sphere=sphereFilter.value;state.page=0;render();});
  q('retry').addEventListener('click',()=>void refresh());for(const [name,delta]of[['prev',-1],['next',1]])q(name).addEventListener('click',()=>{state.page+=delta;render();heading.focus();});
  const onChange=event=>{if(queued||disposed)return;queued=true;queueMicrotask(()=>{queued=false;void refresh(event.detail?.remoteSync?event.detail.canCommit:null);});};
  win.addEventListener('task-state-changed',onChange);win.addEventListener('hanni:calendar-refresh',onChange);win.addEventListener('focus',onChange);
  const timer=win.setInterval(()=>{if(dayOf(new Date())!==today)void refresh();},30000);
  void refresh();
  return ()=>{disposed=true;revision++;disposeMenu?.();win.clearInterval(timer);win.removeEventListener('task-state-changed',onChange);win.removeEventListener('hanni:calendar-refresh',onChange);win.removeEventListener('focus',onChange);};
}

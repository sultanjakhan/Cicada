import { renderTaskImportance } from './task-importance.js';
import { ICONS } from './icons.js';
import { sphereLabel, isInstantTask, taskTime, compareTaskTime, isWorkTask } from './task-model.js';
import { loadProcesses, loadStageBlocks, stageSeconds, stageTimeTitle, taskStage } from './task-processes.js';

const taskKey = row => `${row.source_type}:${row.source_id}`;
const stableJson = value => JSON.stringify(value, (_key, item) => {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  return Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]));
});
const closed = row => row.completed || ['done', 'skipped', 'missed'].includes(row.status_extra);
const dayOf = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const shiftDay = (day, delta) => { const date = new Date(`${day}T12:00:00`); date.setDate(date.getDate() + delta); return dayOf(date); };
// Running work leads the list (2026-09-24); other active tasks are grouped by how
// urgent their planned day is; closed tasks keep one group.
const GROUPS = [['running','В работе'],['overdue','Просрочено'],['today','Сегодня'],['soon','Скоро'],['undated','Без даты'],['completed','Завершённые']];
const groupOf = (row, today) => closed(row) ? 'completed' : row.is_active ? 'running' : !row.date ? 'undated' : row.date < today ? 'overdue' : row.date === today ? 'today' : 'soon';
const groupIndex = (row, today) => GROUPS.findIndex(([id]) => id === groupOf(row, today));
// Work and personal are the main split (2026-09-25): «Личное» is every task whose
// sphere is not work, tasks without a sphere included. Inside it a light second
// row narrows to one sphere when several are present.
const SPHERE_TABS = [['','Все'],['work','Работа'],['personal','Личное']];
const PERSONAL_TABS = [['','Все'],['home','Дом'],['health','Здоровье'],['growth','Развитие'],['personal','Личное'],['none','Без сферы']];
const bucketOf = row => isWorkTask(row) ? 'work' : 'personal';
const personalOf = row => ['home','health','growth','personal'].includes(row.sphere) ? row.sphere : 'none';
const WAIT_ICON = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 1.5h5M3.5 10.5h5M4 1.5v1.3C4 4.1 6 4.8 6 6s-2 1.9-2 3.2v1.3M8 1.5v1.3C8 4.1 6 4.8 6 6s2 1.9 2 3.2v1.3"/></svg>';
const ARROW_ICON = '<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 7h8.5M7.5 3.5 11 7l-3.5 3.5"/></svg>';
const plural = (count, forms) => { const n = Math.abs(count) % 100, d = n % 10; return forms[n > 10 && n < 20 ? 2 : d === 1 ? 0 : d >= 2 && d <= 4 ? 1 : 2]; };
const EMPTY = { search:'Ничего не нашлось. Измени поиск, цель или сферу.', sphere:'В этой сфере задач нет. Выбери другую сферу или создай задачу через «+ Создать».', completed:'Завершённых задач пока нет.', undated:'Все задачи распределены по дням.', today:'На сегодня задач нет.', active:'Задач пока нет. Создай первую через «+ Создать».' };
// Overdue cleanup acts on every task of the group through the task save path.
const BULK = {
  today: { label:'Перенести на сегодня', ask:n => `Перенести ${n} ${plural(n,['задачу','задачи','задач'])}?`, confirm:'Перенести', pending:'Переносим…', verb:'перенести',
    done:n => `Перенесено на сегодня: ${n}.`, partial:(ok,total) => `Перенесено на сегодня: ${ok} из ${total}.` },
  clear: { label:'Убрать дату', ask:n => `Убрать дату у ${n} ${plural(n,['задачи','задач','задач'])}?`, confirm:'Убрать', pending:'Убираем даты…', verb:'убрать дату',
    done:n => `Дата убрана у ${n} ${plural(n,['задачи','задач','задач'])}.`, partial:(ok,total) => `Дата убрана: ${ok} из ${total}.` },
};
const MORE_ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3.5" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="12.5" cy="8" r="1.3"/></svg>';
const SEARCH_ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/></svg>';
let sequence = 0;

// The fresh record keeps title, estimate, goal, importance, kind and sphere; a new
// day keeps the time of day, and «Без даты» clears it (native save rules).
async function saveTaskDate(invoke, row, dueDate) {
  const task = await invoke('get_calendar_task', { id: String(row.source_id) });
  if (!task || String(task.id) !== String(row.source_id) || task.archived || task.completed || task.status !== 'task' || (task.due_date ?? task.date ?? null) !== (row.date ?? null)) throw new Error('changed');
  await invoke('save_calendar_task', { id: String(task.id), title: task.title, dueDate, estimateMinutes: task.duration_minutes ?? null, goalId: task.goal_id ?? null, expectedVersion: task.version });
}

export function mountCalendarTasks(host, dependencies) {
  const { invoke, openTask, editDate, mountMenu, executeAction, notifyChange } = dependencies;
  const doc = host.ownerDocument, win = doc.defaultView;
  const state = dependencies.state || { filter:'active', search:'', goal:'', sphere:'', page:0 };
  // A sphere chosen before the Work/Personal split falls into «Личное»; «Дом» keeps its sphere inside it.
  if (state.sphere === 'home') { state.sphere = 'personal'; state.personal = 'home'; }
  if (['none', 'health', 'growth', 'other'].includes(state.sphere)) state.sphere = 'personal';
  if (!SPHERE_TABS.some(([id]) => id === state.sphere)) state.sphere = '';
  if (state.sphere !== 'personal' || !PERSONAL_TABS.some(([id]) => id === state.personal)) state.personal = '';
  if (state.groupBy !== 'goal') state.groupBy = 'date';
  const prefix = `calendar-tasks-${++sequence}`;
  let rows = [], goals = [], links = [], processes = [], stageBlocks = new Map(), readSignature = null, ready = false, disposed = false, revision = 0, busy = false, queued = false, feedback = '';
  let bulk = null, confirming = null, overdue = [], shown = new Set();
  let today = dayOf(new Date());
  host.classList.add('calendar-tasks');
  host.innerHTML = `<section aria-labelledby="${prefix}-title"><div class="ct-heading"><h2 id="${prefix}-title" tabindex="-1">Задачи <span data-tasks-count></span></h2>
    <div class="ct-grouping" role="group" aria-label="Группировать задачи" data-tasks-grouping>${[['date','По дате'],['goal','По цели']].map(([id,label])=>`<button type="button" data-tasks-group-by="${id}" aria-pressed="false">${label}</button>`).join('')}</div></div>
    <div class="ct-toolbar"><div class="ct-filters" role="group" aria-label="Какие задачи показать">${[['active','Активные'],['today','Сегодня'],['undated','Без даты'],['completed','Завершённые']].map(([id,label])=>`<button type="button" data-tasks-filter="${id}" aria-pressed="false">${label}</button>`).join('')}</div>
    <div class="ct-search-row"><label class="ct-search"><span class="ct-search-icon">${SEARCH_ICON}</span><input type="search" data-tasks-search placeholder="Найти задачу" aria-label="Найти задачу"></label><span class="ct-select"><select data-tasks-goal aria-label="Фильтр по цели"><option value="">Любая цель</option></select></span></div></div>
    <div class="ct-spheres" role="group" aria-label="Рабочие или личные задачи">${SPHERE_TABS.map(([id,label])=>`<button type="button" data-tasks-sphere="${id}" aria-pressed="false"><span>${label}</span><span class="ct-sphere-count" data-tasks-sphere-count></span></button>`).join('')}</div>
    <div class="ct-subspheres" role="group" aria-label="Сфера личных задач" data-tasks-personal hidden></div>
    <p data-tasks-message role="status" aria-live="polite"></p><p class="ct-visually-hidden" data-tasks-stage-announcement role="status" aria-live="polite"></p><button type="button" data-tasks-retry hidden>Повторить загрузку</button>
    <div data-tasks-list></div><div class="ct-pages" data-tasks-pages hidden><button type="button" data-tasks-prev>Назад</button><span data-tasks-page></span><button type="button" data-tasks-next>Далее</button></div></section>`;
  const q = name => host.querySelector(`[data-tasks-${name}]`);
  const heading = host.querySelector('h2'), message = q('message'), list = q('list'), search = q('search'), goalFilter = q('goal');
  const grouping = q('grouping');
  search.value = state.search || '';
  const node = (tag, cls, text) => { const el = doc.createElement(tag); if(cls)el.className=cls; if(text!=null)el.textContent=text; return el; };
  const control = (cls,text,action) => { const el=node('button',cls,text);el.type='button';el.addEventListener('click',action);return el; };
  const findButton = (id, action='open') => [...host.querySelectorAll('[data-task-control]')].find(el => el.dataset.taskId === id && el.dataset.taskControl === action);
  const restore = (id, action='open') => { if(!disposed && host.isConnected)(findButton(id,action)||heading).focus({preventScroll:true}); };
  const say = (text, alert=false) => { feedback=text; message.textContent=text; message.setAttribute('role',alert?'alert':'status'); };
  const goalFor = row => links.find(link=>taskKey(link)===taskKey(row))?.goal_id;
  const goalChain = id => { const chain=[], seen=new Set();let goal=goals.find(g=>String(g.id)===String(id));while(goal&&!seen.has(String(goal.id))){seen.add(String(goal.id));chain.unshift(goal);goal=goals.find(g=>String(g.id)===String(goal.parent_goal_id));}return chain; };
  const goalParts = id => goalChain(id).map(goal=>goal.title);
  const goalPath = id => goalParts(id).join(' / ');
  function matchesGoal(row) {
    const id=goalFor(row); if(!state.goal)return true;if(state.goal==='none')return id==null;
    const seen=new Set();let value=id;
    while(value!=null&&!seen.has(String(value))){if(String(value)===state.goal)return true;seen.add(String(value));value=goals.find(g=>String(g.id)===String(value))?.parent_goal_id;}
    return false;
  }
  const matchesSphere = row => !state.sphere || bucketOf(row) === state.sphere && (state.sphere !== 'personal' || !state.personal || personalOf(row) === state.personal);
  // Timer work of the task inside each stage period, for the stage tooltip.
  const stageTitleOf = (row, stage) => stageTimeTitle(stage, stageSeconds({ blocks: stageBlocks.get(String(row.source_id)) || [], log: row.stage_log, stage: stage.stage, now: new Date() }));
  const formatDate = (date, options) => new Intl.DateTimeFormat('ru',{...options,...(date.slice(0,4)!==today.slice(0,4)?{year:'numeric'}:{})}).format(new Date(`${date}T12:00:00`));
  const dateLabel = date => date===today?'Сегодня':date===shiftDay(today,1)?'Завтра':date===shiftDay(today,-1)?'Вчера':formatDate(date,{day:'numeric',month:'short'});
  function effort(row) {
    const planned=!isInstantTask(row)&&Number(row.duration_minutes)>0?Number(row.duration_minutes):0, actual=Number(row.actual_minutes)>0?Number(row.actual_minutes):0;
    return { text: planned&&actual?`${planned} мин · факт ${actual}`:planned?`${planned} мин`:actual?`факт ${actual} мин`:'', hint:[planned&&`Оценка: ${planned} мин`,actual&&`Учтено: ${actual} мин`].filter(Boolean).join(', ') };
  }
  // Group of a visible row: urgency of the day, or the top-level goal (2026-09-24).
  function sectionOf(row, byGoal) {
    if(!byGoal){const id=groupOf(row,today),rank=GROUPS.findIndex(([group])=>group===id);return {id,label:GROUPS[rank][1],rank,name:''};}
    if(row.is_active)return {id:'running',label:'В работе',rank:0,name:''};
    const root=goalChain(goalFor(row))[0];
    return root?{id:`goal:${root.id}`,label:root.title,rank:1,name:root.title}:{id:'no-goal',label:'Без цели',rank:2,name:''};
  }
  function renderRow(row, section, byGoal) {
    const id=taskKey(row), done=closed(row), overdue=!done&&!!row.date&&row.date<today, running=!done&&!!row.is_active;
    const item=node('li','ct-row');item.dataset.contextRecord=id;item.classList.toggle('is-running',running);item.classList.toggle('is-overdue',overdue);item.classList.toggle('is-done',done);
    const complete=control('ct-complete',done?'✓':'',()=>void finish(row));complete.disabled=busy||done;complete.setAttribute('aria-label',`${done?'Завершена':'Завершить'}: ${row.title}`);if(!done)complete.title='Завершить';
    const title=control('ct-title',row.title,()=>openTask(row,()=>restore(id)));title.title=row.title;
    const meta=node('span','ct-meta');
    // The running accent says «В работе»; a paused task keeps a small mark.
    if(!done&&!running&&row.has_work)meta.append(node('span','ct-status','пауза'));
    const instant=isInstantTask(row), time=taskTime(row), sphere=sphereLabel(row.sphere);
    if(instant){const kind=node('span','ct-kind','Моментальная');kind.title='Отмечается одним нажатием, без таймера';meta.append(kind);}
    // A day the group or filter already names is not repeated; «Без даты» is never printed.
    const sameDay=row.date===today&&(section==='today'||section==='running'||state.filter==='today');
    const day=row.date&&!sameDay?dateLabel(row.date):'', when=[day,time].filter(Boolean).join(', ');
    let date=null;
    if(when){
      date=control('ct-date',when,()=>editDate(row,()=>restore(id,'date')));date.disabled=busy;date.classList.toggle('is-overdue',overdue);
      date.title=`${formatDate(row.date,{day:'numeric',month:'long',weekday:'short'})}${time?`, ${time}`:''}${overdue?' · просрочено':''} — изменить дату`;
      if(overdue)date.setAttribute('aria-label',`${when}, просрочено. Изменить дату`);
      meta.append(date);
    }
    // Stages belong to a task with a process (2026-09-25); instant and closed tasks show none.
    const stage=!done&&!instant?taskStage(row,processes):null;
    if(stage){
      const group=node('span','ct-stage-group');
      const chip=node('span','ct-stage');chip.dataset.taskId=id;chip.title=stageTitleOf(row,stage);
      chip.append(node('span','ct-stage-prefix','Этап:'),node('span','ct-stage-label',stage.label||(stage.waiting?'Жду ответа':'Не выбран')));
      // «Жду ответа»: a small hourglass after the stage name.
      if(stage.waiting){const mark=node('span','ct-waiting');mark.innerHTML=WAIT_ICON;mark.append(node('span','ct-visually-hidden','жду ответа'));chip.append(mark);}
      chip.classList.toggle('is-deleted',stage.deleted);
      group.append(chip);
      if(stage.next){
        const next=control('ct-stage-next',null,()=>void advance(id));next.innerHTML=ARROW_ICON;
        next.title=`${stage.stage?'Дальше':'Начать'}: ${stage.next.title}`;next.setAttribute('aria-label',`Следующая стадия «${stage.next.title}»: ${row.title}`);
        next.disabled=busy;next.dataset.taskId=id;next.dataset.taskControl='stage-next';group.append(next);
      }
      meta.append(group);
    }
    const work=effort(row);if(work.text){const estimate=node('span','ct-estimate',work.text);estimate.title=work.hint;meta.append(estimate);}
    // A row names its sphere unless the switch already does.
    if(sphere&&state.sphere!=='work'&&!state.personal&&!(state.sphere==='personal'&&row.sphere==='personal')){const label=node('span','ct-sphere',sphere);label.title=`Сфера: ${sphere}`;meta.append(label);}
    // A goal group already names the top-level goal; the row keeps the sub-goal.
    const goalId=goalFor(row), chain=goalParts(goalId), parts=byGoal&&section.startsWith('goal:')?chain.slice(1):chain;
    if(parts.length&&!(state.goal&&String(goalId)===state.goal)){const goal=node('span','ct-goal',parts.at(-1));goal.title=chain.join(' / ');meta.append(goal);}
    renderTaskImportance(doc,meta,row,item);
    const content=node('div','ct-content');content.append(title,meta);
    if(running)content.append(node('span','ct-visually-hidden','В работе'));
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
    for(const [button,action] of [[title,'open'],[date,'date'],[more,'menu'],[complete,'finish']])if(button){button.dataset.taskId=id;button.dataset.taskControl=action;}
    item.append(complete,content,actions);
    return item;
  }
  function groupHeader(section, total) {
    const header=node('div',`ct-group ct-group--${section.id.startsWith('goal:')?'goal':section.id}`);header.dataset.tasksGroup=section.id;
    const title=node('h3','ct-group-title');title.setAttribute('aria-label',`${section.label}, ${total}`);title.append(node('span','ct-group-label',section.label),node('span','ct-group-count',String(total)));title.title=section.label;
    header.append(title);
    if(section.id==='overdue'&&state.filter==='active')header.append(overdueActions(total));
    return header;
  }
  function overdueActions(total) {
    const box=node('div','ct-group-actions');
    if(bulk){box.append(node('span','ct-confirm-text',BULK[bulk].pending));return box;}
    if(confirming){
      const kind=confirming;box.classList.add('is-confirming');box.append(node('span','ct-confirm-text',BULK[kind].ask(total)));
      const yes=control('ct-group-action is-primary',BULK[kind].confirm,()=>void moveOverdue(kind));yes.dataset.tasksBulk='confirm';
      const no=control('ct-group-action','Отмена',()=>{confirming=null;render();focusBulk(kind);});no.dataset.tasksBulk='cancel';
      box.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();confirming=null;render();focusBulk(kind);}});
      box.append(yes,no);return box;
    }
    for(const kind of ['today','clear']){const button=control('ct-group-action',BULK[kind].label,()=>{confirming=kind;render();focusBulk('confirm');});button.dataset.tasksBulk=kind;button.disabled=busy;box.append(button);}
    return box;
  }
  const focusBulk = kind => { if(!disposed)(host.querySelector(`[data-tasks-bulk="${kind}"]`)||heading).focus({preventScroll:true}); };
  // The second row inside «Личное»: shown only when several spheres are present.
  function renderPersonal(matching) {
    const box=q('personal'), counts=new Map(PERSONAL_TABS.map(([id])=>[id,0]));
    for(const row of matching.filter(item=>bucketOf(item)==='personal')){counts.set('',counts.get('')+1);counts.set(personalOf(row),counts.get(personalOf(row))+1);}
    const present=PERSONAL_TABS.filter(([id])=>id&&counts.get(id)>0);
    box.hidden=state.sphere!=='personal'||(present.length<2&&!state.personal);
    if(box.hidden){box.replaceChildren();return;}
    const focused=box.contains(doc.activeElement)?doc.activeElement.dataset.tasksPersonalOption:null;
    box.replaceChildren(...PERSONAL_TABS.filter(([id])=>!id||counts.get(id)>0||id===state.personal).map(([id,label])=>{
      const button=node('button');button.type='button';button.dataset.tasksPersonalOption=id;button.setAttribute('aria-pressed',String(id===state.personal));
      button.append(node('span',null,label),node('span','ct-sphere-count',String(counts.get(id))));button.setAttribute('aria-label',`${label}: ${counts.get(id)}`);
      return button;
    }));
    if(focused!=null)box.querySelector(`[data-tasks-personal-option="${focused}"]`)?.focus({preventScroll:true});
  }
  function render() {
    if(disposed||!ready)return;
    const focused=doc.activeElement, focusId=focused?.dataset.taskId, focusAction=focused?.dataset.taskControl, focusedBulk=focused?.dataset.tasksBulk;
    const query=state.search.trim().toLocaleLowerCase('ru');
    const eligible=rows.filter(row=>(state.filter==='completed'?closed(row):!closed(row))&&(state.filter!=='today'||row.date===today)&&(state.filter!=='undated'||!row.date));
    const matching=eligible.filter(row=>matchesGoal(row)&&`${row.title} ${goalPath(goalFor(row))}`.toLocaleLowerCase('ru').includes(query));
    const counts=new Map(SPHERE_TABS.map(([id])=>[id,0]));
    for(const row of matching){counts.set('',counts.get('')+1);counts.set(bucketOf(row),counts.get(bucketOf(row))+1);}
    const byGoal=state.groupBy==='goal'&&state.filter!=='completed';
    renderPersonal(matching);
    const visible=matching.filter(matchesSphere).map(row=>({row,section:sectionOf(row,byGoal)})).sort((a,b)=>a.section.rank-b.section.rank||a.section.name.localeCompare(b.section.name,'ru')||a.section.id.localeCompare(b.section.id)
      ||(byGoal?groupIndex(a.row,today)-groupIndex(b.row,today):0)||(Number(b.row.priority)||0)-(Number(a.row.priority)||0)||(a.row.date||'9999').localeCompare(b.row.date||'9999')||compareTaskTime(a.row,b.row)||a.row.title.localeCompare(b.row.title,'ru')||taskKey(a.row).localeCompare(taskKey(b.row)));
    shown=new Set(visible.map(({row})=>taskKey(row)));
    q('count').textContent=String(visible.length);
    host.querySelectorAll('[data-tasks-filter]').forEach(el=>el.setAttribute('aria-pressed',String(el.dataset.tasksFilter===state.filter)));
    host.querySelectorAll('[data-tasks-sphere]').forEach(el=>{const id=el.dataset.tasksSphere,count=String(counts.get(id));el.setAttribute('aria-pressed',String(id===state.sphere));el.querySelector('[data-tasks-sphere-count]').textContent=count;el.setAttribute('aria-label',`${SPHERE_TABS.find(([tab])=>tab===id)[1]}: ${count}`);});
    host.querySelectorAll('[data-tasks-group-by]').forEach(el=>el.setAttribute('aria-pressed',String(el.dataset.tasksGroupBy===state.groupBy)));
    grouping.hidden=state.filter==='completed';
    state.page=Math.max(0,Math.min(state.page||0,Math.ceil(visible.length/50)-1));
    const totals=new Map();for(const {section} of visible)totals.set(section.id,(totals.get(section.id)||0)+1);
    overdue=visible.filter(({section})=>section.id==='overdue').map(({row})=>row);if(!overdue.length&&!bulk)confirming=null;
    // Active mixes several groups; the other filters name their single group unless grouped by goal.
    const grouped=state.filter==='active'||byGoal;
    list.replaceChildren();let lastGroup=null, ul;
    for(const {row,section} of visible.slice(state.page*50,(state.page+1)*50)) {
      if(section.id!==lastGroup){
        if(grouped)list.append(groupHeader(section,totals.get(section.id)));
        ul=node('ul','ct-list');list.append(ul);lastGroup=section.id;
      }
      ul.append(renderRow(row,section.id,byGoal));
    }
    if(!visible.length)list.append(node('p','ct-empty',query||state.goal?EMPTY.search:state.sphere&&counts.get('')?EMPTY.sphere:EMPTY[state.filter]||EMPTY.active));
    q('pages').hidden=visible.length<=50;q('prev').disabled=state.page===0;q('next').disabled=(state.page+1)*50>=visible.length;
    q('page').textContent=`${state.page*50+1}–${Math.min((state.page+1)*50,visible.length)} из ${visible.length}`;
    if(focusId&&!focused.isConnected)restore(focusId,focusAction);
    if(focusedBulk&&!focused.isConnected)focusBulk(focusedBulk);
  }
  async function refresh(canCommit=null) {
    if(disposed||busy||canCommit&&!canCommit())return;
    const request=++revision;host.setAttribute('aria-busy','true');if(!ready)message.textContent='Загружаем задачи…';
    try{
      const result=await Promise.all([invoke('get_calendar_tasks',{includeCompleted:true}),invoke('get_goals',{tabName:null}),invoke('get_calendar_task_goals'),loadProcesses(invoke)]);
      if(disposed||request!==revision||canCommit&&!canCommit())return;
      if(result.some(value=>!Array.isArray(value)))throw new Error('Invalid task response');
      const nextRows=[...new Map(result[0].filter(row=>row.source_type==='note'&&!row.readonly&&!row.archived).map(row=>[taskKey(row),row])).values()];
      // Time per stage is context for the tooltip; a failed read leaves it empty.
      const blocks=await loadStageBlocks(invoke,nextRows.filter(row=>!closed(row)&&!isInstantTask(row)&&taskStage(row,result[3])).map(row=>row.source_id));
      if(disposed||request!==revision||canCommit&&!canCommit())return;
      const nextToday=dayOf(new Date());
      const nextSignature=stableJson([nextToday,nextRows,result[1],result[2],result[3],[...blocks].sort(([a],[b])=>String(a).localeCompare(String(b)))]);
      ready=true;
      if(nextSignature===readSignature){message.textContent=feedback;q('retry').hidden=true;return;}
      rows=nextRows;goals=result[1];links=result[2];processes=result[3];stageBlocks=blocks;today=nextToday;
      goalFilter.replaceChildren(new win.Option('Любая цель',''),new win.Option('Без цели','none'),...goals.map(goal=>new win.Option(goalPath(goal.id),String(goal.id))));
      if(state.goal&&!['none',...goals.map(goal=>String(goal.id))].includes(state.goal))state.goal='';goalFilter.value=state.goal;
      message.textContent=feedback;q('retry').hidden=true;render();readSignature=nextSignature;
    }catch{if(!disposed&&request===revision){message.textContent=ready?'Не удалось обновить задачи. Показан предыдущий список.':'Не удалось загрузить задачи. Это не означает, что список пуст.';q('retry').hidden=false;}}
    finally{if(!disposed&&request===revision)host.removeAttribute('aria-busy');}
  }
  async function finish(row,action='finish'){
    if(busy||disposed)return;busy=true;revision++;feedback='';message.textContent='';render();
    try{const result=await executeAction(row,action);if(result===false)return;notifyChange();busy=false;await refresh();if(!disposed){say({start:'Задача в работе.',pause:'Задача на паузе.',finish:'Задача завершена.'}[action]);restore(taskKey(row),action==='finish'?'open':'execute');}}
    catch(error){if(error?.refreshRequired)notifyChange();busy=false;await refresh();if(!disposed)say(error?.message||'Не удалось выполнить действие.',true);}
    finally{busy=false;render();}
  }
  async function moveOverdue(kind) {
    const targets=[...overdue];
    if(busy||disposed||!targets.length)return;
    busy=true;bulk=kind;confirming=null;revision++;feedback='';message.textContent='';render();
    const dueDate=kind==='today'?dayOf(new Date()):null, failed=[];
    // One at a time: each save checks the version it has just read.
    for(const row of targets){try{await saveTaskDate(invoke,row,dueDate);}catch{failed.push(row);}if(disposed)return;}
    if(failed.length<targets.length)notifyChange();
    busy=false;bulk=null;await refresh();if(disposed)return;
    const spec=BULK[kind], ok=targets.length-failed.length;
    if(!failed.length)say(spec.done(ok));
    else{
      const names=failed.slice(0,3).map(row=>`«${row.title}»`).join(', ')+(failed.length>3?` и ещё ${failed.length-3}`:'');
      say(`${ok?`${spec.partial(ok,targets.length)} `:''}Не удалось ${spec.verb}: ${names}. ${failed.length===1?'Задача могла измениться':'Задачи могли измениться'} — обнови список и повтори.`,true);
    }
    render();focusBulk(failed.length?kind:'none');
  }
  async function advance(id) {
    const row=rows.find(item=>taskKey(item)===id), stage=row&&taskStage(row,processes), next=stage?.next;
    if(!next||busy||disposed)return;
    busy=true;revision++;feedback='';message.textContent='';render();
    let succeeded=false;
    try{
      const result=await invoke('set_calendar_task_stage',{id:String(row.source_id),stage:next.id,waiting:null});
      if(disposed)return;
      rows=rows.map(item=>taskKey(item)===id?{...item,process:result?.process??item.process,stage:typeof result?.stage==='string'?result.stage:next.id,waiting:typeof result?.waiting==='boolean'?result.waiting:item.waiting,stage_log:result?.stage_log??item.stage_log}:item);
      succeeded=true;
    }catch{}
    finally{
      if(!disposed){
        busy=false;render();
        if(succeeded){host.querySelector('[data-tasks-stage-announcement]').textContent=`Этап: ${taskStage(rows.find(item=>taskKey(item)===id),processes)?.label||next.title}.`;notifyChange();}
        else say('Не удалось перейти к следующему этапу. Повтори.',true);
        restore(id,findButton(id,'stage-next')?'stage-next':'open');
      }
    }
  }
  const disposeMenu=mountMenu?.(host,{getRecord:item=>rows.find(row=>taskKey(row)===item.dataset.contextRecord),restoreFocus:(item,trigger)=>restore(item.dataset.contextRecord,'recordMenu' in trigger.dataset?'menu':'open')});
  const choose=(key,value)=>{state[key]=value;state.page=0;confirming=null;render();};
  host.querySelectorAll('[data-tasks-filter]').forEach(el=>el.addEventListener('click',()=>choose('filter',el.dataset.tasksFilter)));
  host.querySelectorAll('[data-tasks-sphere]').forEach(el=>el.addEventListener('click',()=>{state.personal='';choose('sphere',el.dataset.tasksSphere);}));
  q('personal').addEventListener('click',event=>{const button=event.target.closest('[data-tasks-personal-option]');if(button){choose('personal',button.dataset.tasksPersonalOption);q('personal').querySelector(`[data-tasks-personal-option="${button.dataset.tasksPersonalOption}"]`)?.focus({preventScroll:true});}});
  host.querySelectorAll('[data-tasks-group-by]').forEach(el=>el.addEventListener('click',()=>choose('groupBy',el.dataset.tasksGroupBy)));
  search.addEventListener('input',()=>choose('search',search.value));goalFilter.addEventListener('change',()=>choose('goal',goalFilter.value));
  q('retry').addEventListener('click',()=>void refresh());for(const [name,delta]of[['prev',-1],['next',1]])q(name).addEventListener('click',()=>{state.page+=delta;render();heading.focus();});
  const onChange=event=>{if(queued||disposed)return;queued=true;queueMicrotask(()=>{queued=false;void refresh(event.detail?.remoteSync?event.detail.canCommit:null);});};
  win.addEventListener('task-state-changed',onChange);win.addEventListener('hanni:calendar-refresh',onChange);win.addEventListener('hanni:processes-changed',onChange);win.addEventListener('focus',onChange);
  // Stage tooltips of running tasks follow their timer.
  const updateStageTitles=()=>host.querySelectorAll('.ct-stage[data-task-id]').forEach(chip=>{const row=rows.find(item=>taskKey(item)===chip.dataset.taskId),stage=row?.is_active&&taskStage(row,processes);if(stage)chip.title=stageTitleOf(row,stage);});
  const timer=win.setInterval(()=>{if(dayOf(new Date())!==today)void refresh();else updateStageTitles();},30000);
  void refresh();
  return ()=>{disposed=true;revision++;disposeMenu?.();win.clearInterval(timer);win.removeEventListener('task-state-changed',onChange);win.removeEventListener('hanni:calendar-refresh',onChange);win.removeEventListener('hanni:processes-changed',onChange);win.removeEventListener('focus',onChange);};
}

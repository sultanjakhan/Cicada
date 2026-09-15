const taskKey = row => `${row.source_type}:${row.source_id}`;
const closed = row => row.completed || ['done', 'skipped', 'missed'].includes(row.status_extra);
const dayOf = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
let sequence = 0;

export function mountCalendarTasks(host, dependencies) {
  const { invoke, openTask, editDate, mountMenu, executeAction, notifyChange } = dependencies;
  const doc = host.ownerDocument, win = doc.defaultView;
  const state = dependencies.state || { filter:'active', search:'', goal:'', page:0 };
  const prefix = `calendar-tasks-${++sequence}`;
  let rows = [], goals = [], links = [], ready = false, disposed = false, revision = 0, busy = false, queued = false, feedback = '';
  let today = dayOf(new Date());
  host.classList.add('calendar-tasks');
  host.innerHTML = `<section aria-labelledby="${prefix}-title"><div class="ct-heading"><h2 id="${prefix}-title" tabindex="-1">Задачи <span data-tasks-count></span></h2></div>
    <div class="ct-filters" role="group" aria-label="Какие задачи показать">${[['active','Активные'],['today','Сегодня'],['undated','Без даты'],['completed','Завершённые']].map(([id,label])=>`<button type="button" data-tasks-filter="${id}" aria-pressed="false">${label}</button>`).join('')}</div>
    <div class="ct-search-row"><input type="search" data-tasks-search placeholder="Найти задачу" aria-label="Найти задачу"><select data-tasks-goal aria-label="Фильтр по цели"><option value="">Любая цель</option></select></div>
    <p data-tasks-message role="status" aria-live="polite"></p><button type="button" data-tasks-retry hidden>Повторить загрузку</button>
    <div data-tasks-list></div><div class="ct-pages" data-tasks-pages hidden><button type="button" data-tasks-prev>Назад</button><span data-tasks-page></span><button type="button" data-tasks-next>Далее</button></div></section>`;
  const q = name => host.querySelector(`[data-tasks-${name}]`);
  const heading = host.querySelector('h2'), message = q('message'), list = q('list'), search = q('search'), goalFilter = q('goal');
  search.value = state.search || '';
  const node = (tag, cls, text) => { const el = doc.createElement(tag); if(cls)el.className=cls; if(text!=null)el.textContent=text; return el; };
  const control = (cls,text,action) => { const el=node('button',cls,text);el.type='button';el.addEventListener('click',action);return el; };
  const findButton = (id, action='open') => [...host.querySelectorAll('[data-task-control]')].find(el => el.dataset.taskId === id && el.dataset.taskControl === action);
  const restore = (id, action='open') => { if(!disposed && host.isConnected)(findButton(id,action)||heading).focus({preventScroll:true}); };
  const goalFor = row => links.find(link=>taskKey(link)===taskKey(row))?.goal_id;
  const goalPath = id => { const parts=[], seen=new Set();let goal=goals.find(g=>String(g.id)===String(id));while(goal&&!seen.has(String(goal.id))){seen.add(String(goal.id));parts.unshift(goal.title);goal=goals.find(g=>String(g.id)===String(goal.parent_goal_id));}return parts.join(' / '); };
  function matchesGoal(row) {
    const id=goalFor(row); if(!state.goal)return true;if(state.goal==='none')return id==null;
    const seen=new Set();let value=id;
    while(value!=null&&!seen.has(String(value))){if(String(value)===state.goal)return true;seen.add(String(value));value=goals.find(g=>String(g.id)===String(value))?.parent_goal_id;}
    return false;
  }
  const group = row => closed(row)?5:row.is_active?0:!row.date?4:row.date<today?1:row.date===today?2:3;
  const labels = ['В работе','Ранее','Сегодня','Позже','Без даты','Завершённые'];
  function render() {
    if(disposed||!ready)return;
    const focused=doc.activeElement, focusId=focused?.dataset.taskId, focusAction=focused?.dataset.taskControl;
    const query=state.search.trim().toLocaleLowerCase('ru');
    const eligible=rows.filter(row=>(state.filter==='completed'?closed(row):!closed(row))&&(state.filter!=='today'||row.date===today)&&(state.filter!=='undated'||!row.date));
    const visible=eligible.filter(row=>matchesGoal(row)&&`${row.title} ${goalPath(goalFor(row))}`.toLocaleLowerCase('ru').includes(query)).sort((a,b)=>group(a)-group(b)||(Number(b.priority)||0)-(Number(a.priority)||0)||(a.date||'9999').localeCompare(b.date||'9999')||a.title.localeCompare(b.title,'ru')||taskKey(a).localeCompare(taskKey(b)));
    q('count').textContent=String(visible.length);
    host.querySelectorAll('[data-tasks-filter]').forEach(el=>el.setAttribute('aria-pressed',String(el.dataset.tasksFilter===state.filter)));
    state.page=Math.max(0,Math.min(state.page||0,Math.ceil(visible.length/50)-1));
    list.replaceChildren();let lastGroup=-1, ul;
    for(const row of visible.slice(state.page*50,(state.page+1)*50)) {
      const currentGroup=group(row);
      if(currentGroup!==lastGroup){list.append(node('h3','ct-group',labels[currentGroup]));ul=node('ul','ct-list');list.append(ul);lastGroup=currentGroup;}
      const id=taskKey(row), item=node('li','ct-row');item.dataset.contextRecord=id;
      const complete=control('ct-complete',closed(row)?'✓':'',()=>void finish(row));complete.disabled=busy||closed(row);complete.setAttribute('aria-label',`${closed(row)?'Завершена':'Завершить'}: ${row.title}`);
      const title=control('ct-title',row.title,()=>openTask(row,()=>restore(id)));const content=node('div','ct-content');content.append(title);
      const parts=[goalPath(goalFor(row)),row.is_active?'В работе':row.has_work?'На паузе':''].filter(Boolean);
      if(parts.length)content.append(node('span','ct-meta',parts.join(' · ')));
      const date=control('ct-date',row.date?new Intl.DateTimeFormat('ru',{day:'numeric',month:'short',...(row.date.slice(0,4)!==today.slice(0,4)?{year:'numeric'}:{})}).format(new Date(`${row.date}T12:00:00`)):'Без даты',()=>editDate(row,()=>restore(id,'date')));date.disabled=busy;
      const estimate=node('span','ct-estimate',row.duration_minutes>0?`${row.duration_minutes} мин`:'');
      const more=control('ct-more','⋯',()=>{});more.dataset.recordMenu='';more.setAttribute('aria-label',`Действия: ${row.title}`);more.setAttribute('aria-haspopup','menu');more.setAttribute('aria-expanded','false');more.disabled=busy;
      for(const [button,action] of [[title,'open'],[date,'date'],[more,'menu'],[complete,'finish']]){button.dataset.taskId=id;button.dataset.taskControl=action;}
      item.append(complete,content,estimate,date,more);ul.append(item);
    }
    if(!visible.length)list.append(node('p','ct-empty',query||state.goal?'Нет задач с такими условиями. Измени поиск или фильтры.':state.filter==='completed'?'Завершённых задач пока нет.':state.filter==='undated'?'Все задачи распределены по дням.':state.filter==='today'?'На сегодня задач нет.':'Задач пока нет. Добавь первую кнопкой «Новая задача» выше.'));
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
  async function finish(row){
    if(busy||disposed)return;busy=true;revision++;feedback='';message.textContent='';render();
    try{await executeAction(row,'finish');notifyChange();busy=false;await refresh();if(!disposed){feedback='Задача завершена.';message.textContent=feedback;restore(taskKey(row));}}
    catch(error){busy=false;await refresh();if(!disposed){feedback=error?.message||'Не удалось завершить задачу.';message.textContent=feedback;message.setAttribute('role','alert');}}
    finally{busy=false;render();}
  }
  const disposeMenu=mountMenu?.(host,{getRecord:item=>rows.find(row=>taskKey(row)===item.dataset.contextRecord),restoreFocus:(item,trigger)=>restore(item.dataset.contextRecord,'recordMenu' in trigger.dataset?'menu':'open')});
  host.querySelectorAll('[data-tasks-filter]').forEach(el=>el.addEventListener('click',()=>{state.filter=el.dataset.tasksFilter;state.page=0;render();}));
  search.addEventListener('input',()=>{state.search=search.value;state.page=0;render();});goalFilter.addEventListener('change',()=>{state.goal=goalFilter.value;state.page=0;render();});
  q('retry').addEventListener('click',()=>void refresh());for(const [name,delta]of[['prev',-1],['next',1]])q(name).addEventListener('click',()=>{state.page+=delta;render();heading.focus();});
  const onChange=event=>{if(queued||disposed)return;queued=true;queueMicrotask(()=>{queued=false;void refresh(event.detail?.remoteSync?event.detail.canCommit:null);});};
  win.addEventListener('task-state-changed',onChange);win.addEventListener('hanni:calendar-refresh',onChange);win.addEventListener('focus',onChange);
  const timer=win.setInterval(()=>{if(dayOf(new Date())!==today)void refresh();},30000);
  void refresh();
  return ()=>{disposed=true;revision++;disposeMenu?.();win.clearInterval(timer);win.removeEventListener('task-state-changed',onChange);win.removeEventListener('hanni:calendar-refresh',onChange);win.removeEventListener('focus',onChange);};
}

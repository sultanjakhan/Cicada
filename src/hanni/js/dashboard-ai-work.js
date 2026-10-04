// Opt-in dashboard projection; no IPC, storage, launch or timer inference.
const states = {running:'В работе по отчёту',waiting:'Ожидание по отчёту',done:'Исполнитель сообщил о завершении',error:'Ошибка по отчёту',cancelled:'Отмена по отчёту'};
export function groupAiWork(tasks, mode = 'project', tag = '') {
  const ids = new Set(), groups = new Map();
  for (const task of tasks) {
    if (typeof task.taskKey !== 'string' || !task.taskKey || ids.has(task.taskKey) || typeof task.title !== 'string' || !Array.isArray(task.tags) || task.tags.some(t => typeof t.id !== 'string' || !t.id || typeof t.name !== 'string') || ![true,false,null].includes(task.needsUser) || (task.runTaskKeys && (!Array.isArray(task.runTaskKeys) || task.runTaskKeys.some(k=>typeof k!=='string' || !k))) || (task.resultVersion != null && (!Number.isSafeInteger(task.resultVersion) || task.resultVersion<1))) throw Error('Invalid AI task projection');
    ids.add(task.taskKey);
    if (tag && !task.tags.some(t => t.id === tag)) continue;
    const primary = [...task.tags].sort((a,b)=>a.id < b.id ? -1 : a.id > b.id ? 1 : 0)[0];
    const group = mode === 'tag' ? (primary || {id:'',name:'Без тегов'}) : (task.project || {id:'',name:'Без проекта'});
    if (typeof group.id !== 'string' || typeof group.name !== 'string') throw Error('Invalid group');
    if (!groups.has(group.id)) groups.set(group.id,{...group,tasks:[]});
    groups.get(group.id).tasks.push(task);
  }
  return [...groups.values()];
}
export function mountDashboardAiWork(host, { read = null, onOpenTask = () => {}, onOpenTasks = () => {} } = {}) {
  const doc=host.ownerDocument;
  const node=(tag,cls,text)=>{const el=doc.createElement(tag);if(cls)el.className=cls;if(text)el.textContent=text;return el;};
  const section=node('section','dashboard-ai-work calendar-next-action__surface');section.setAttribute('aria-label','Работа ИИ');
  const header=node('header','dashboard-ai-work__header'),heading=node('h2',null,'Работа ИИ'),refresh=node('button','dashboard-ai-work__refresh','Обновить');refresh.type='button';refresh.setAttribute('aria-label','Обновить сведения о работе ИИ');header.append(heading,refresh);
  const counts=node('p','dashboard-ai-work__counts'),notice=node('p','dashboard-ai-work__notice');notice.setAttribute('role','status');notice.setAttribute('aria-live','polite');
  const controls=node('div','dashboard-ai-work__filters'),label=node('label',null,'Группировать'),grouping=node('select');
  for(const [value,text] of [['project','По проектам'],['tag','По тегам']]){const option=node('option',null,text);option.value=value;grouping.append(option);}label.append(grouping);
  const tagLabel=node('label',null,'Тег'),tag=node('select');tagLabel.append(tag);controls.append(label,tagLabel);
  const list=node('div','dashboard-ai-work__list'),allTasks=node('button','dashboard-ai-work__all-tasks','Открыть задачи');allTasks.type='button';allTasks.addEventListener('click',()=>{if(!disposed)onOpenTasks();});
  section.append(header,counts,notice,controls,list,allTasks);host.append(section);
  let projection=null,busy=false,disposed=false;
  function unavailable(text,state='unavailable'){
    section.dataset.state=state;counts.hidden=true;controls.hidden=true;list.replaceChildren();allTasks.hidden=false;notice.textContent=text;
  }
  const reportFor=task=>projection.reports.filter(r=>(task.runTaskKeys||[task.taskKey]).includes(r.taskKey)).sort((a,b)=>(Date.parse(b.receivedAt)||0)-(Date.parse(a.receivedAt)||0)||(b.receivedOrder||0)-(a.receivedOrder||0))[0];
  function paint(){
    if(!projection||busy)return;
    section.dataset.state=projection.tasks.length?'ready':'empty';
    const groups=groupAiWork(projection.tasks,grouping.value,tag.value),visible=groups.flatMap(g=>g.tasks),needs=projection.tasks.filter(t=>t.needsUser===true).length;
    counts.hidden=!projection.tasks.length;controls.hidden=!projection.tasks.length;allTasks.hidden=!!visible.length;
    counts.textContent=`Задач: ${projection.tasks.length}${needs?` · Требуют внимания: ${needs}`:''}${tag.value?` · Показано: ${visible.length}`:''}`;
    notice.textContent=projection.tasks.length?'Текущее выполнение не подтверждено. Здесь показаны последние полученные сведения.':'Пока нет связанных отчётов ИИ. Ваши задачи доступны в разделе «Задачи».';
    if(projection.tasks.some(t=>t.needsUser===null))notice.textContent+=' Для части задач необходимость приёмки неизвестна.';
    list.replaceChildren();
    for(const group of groups){
      const block=node('section','dashboard-ai-work__group'),title=node('h3',null,`${group.name} · ${group.tasks.length}`),rows=node('ul');block.append(title,rows);list.append(block);
      for(const task of group.tasks){
        const item=node('li','dashboard-ai-work__row');item.dataset.aiTask=task.taskKey;
        const open=node('button','dashboard-ai-work__task-title',task.title);open.type='button';open.addEventListener('click',()=>{if(!disposed)onOpenTask(task.taskKey);});item.append(open);
        if(task.needsUser===true)item.append(node('strong','dashboard-ai-work__badge','Нужно ваше решение'));
        const report=reportFor(task);
        item.append(node('p','dashboard-ai-work__summary',report?`${states[report.status]}${report.stage?` · ${report.stage}`:''}`:'Отчёт исполнителя ещё не получен.'));
        if(task.resultVersion)item.append(node('p','dashboard-ai-work__result',`Результат v${task.resultVersion} · ${task.reviewState==='awaiting_review'?'на приёмке':task.reviewState==='accepted'?'принят':task.reviewState==='awaiting_dispatch'?'ожидает передачи':task.reviewState==='running'?'запуск подтверждён исполнителем':'состояние неизвестно'}`));
        if(report){
          const details=node('details','dashboard-ai-work__details');details.append(node('summary',null,'Сведения об отчёте'));
          details.append(node('p',null,`Исполнитель: ${report.agent||'не указан'} · Модель в отчёте: ${report.model||'не указана'}`));
          details.append(node('p',null,`Получен: ${report.receivedAt||'время неизвестно'} · ${report.freshness==='fresh'?'отчёт отмечен как свежий':report.freshness==='stale'?'отчёт устарел':'актуальность неизвестна'}. Текущее выполнение не подтверждено.`));item.append(details);
        }
        if(task.tags.length)item.append(node('span','dashboard-ai-work__tags',task.tags.map(t=>t.name).join(' · ')));
        rows.append(item);
      }
    }
    if(projection.tasks.length&&!visible.length)list.append(node('p','dashboard-ai-work__empty','По этому тегу задач нет. Выберите другой тег или «Все теги».'));
  }
  async function load(){
    if(disposed||busy)return;
    if(!read){unavailable('Сведения о работе ИИ пока недоступны. Ваши задачи можно открыть отдельно.');refresh.disabled=true;return;}
    busy=true;refresh.disabled=grouping.disabled=tag.disabled=true;section.setAttribute('aria-busy','true');section.dataset.state='loading';counts.hidden=true;controls.hidden=true;notice.textContent='Загружаем сведения о работе ИИ…';
    try{
      const value=await read();if(disposed)return;
      if(!Array.isArray(value?.tasks)||!Array.isArray(value?.reports))throw Error('Invalid source');
      groupAiWork(value.tasks);
      if(value.reports.some(r=>typeof r.taskKey!=='string'||!states[r.status]))throw Error('Invalid report');
      projection=structuredClone(value);
      const selected=tag.value;tag.replaceChildren();const all=node('option',null,'Все теги');all.value='';tag.append(all);
      const tags=new Map();for(const task of projection.tasks)for(const t of task.tags)tags.set(t.id,t.name);
      for(const [id,name]of tags){const option=node('option',null,name);option.value=id;tag.append(option);}tag.value=tags.has(selected)?selected:'';
      busy=false;paint();
    }catch{if(!disposed){projection=null;unavailable('Не удалось обновить сведения о работе ИИ. Попробуйте ещё раз. Это не означает, что работа завершена или задач нет.','error');}}
    finally{busy=false;if(!disposed){refresh.disabled=grouping.disabled=tag.disabled=false;section.removeAttribute('aria-busy');}}
  }
  grouping.addEventListener('change',paint);tag.addEventListener('change',paint);refresh.addEventListener('click',()=>void load());void load();
  return ()=>{disposed=true;section.remove();};
}

// Opt-in dashboard projection; no IPC, storage, launch or timer inference.
const states = {running:'В работе по отчёту',waiting:'Ожидание по отчёту',done:'Исполнитель сообщил done',error:'Ошибка по отчёту',cancelled:'Отмена по отчёту'};
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
export function mountDashboardAiWork(host, { read = null, onOpenTask = () => {} } = {}) {
  const doc=host.ownerDocument, section=doc.createElement('section');section.className='dashboard-ai-work';section.setAttribute('aria-label','ИИ-работы');
  const heading=doc.createElement('h2');heading.textContent='ИИ-работы';
  const counts=doc.createElement('p'),notice=doc.createElement('p');notice.setAttribute('role','status');
  const label=doc.createElement('label');label.textContent='Группировать ИИ-работы';
  const grouping=doc.createElement('select');for(const [value,text] of [['project','По проектам'],['tag','По основному тегу']]){const o=doc.createElement('option');o.value=value;o.textContent=text;grouping.append(o);}label.append(grouping);
  const tagLabel=doc.createElement('label');tagLabel.textContent='Тег';const tag=doc.createElement('select');tagLabel.append(tag);
  const refresh=doc.createElement('button');refresh.type='button';refresh.textContent='Обновить ИИ-работы';
  const list=doc.createElement('div');section.append(heading,counts,notice,label,tagLabel,refresh,list);host.append(section);
  let projection=null,busy=false,disposed=false;
  const unknown=()=>{counts.textContent='Активных: неизвестно · Нужен я: неизвестно';notice.textContent='Live feed не подключён. Нет данных об ИИ-работах.';};
  function paint(){
    if(!projection){unknown();list.replaceChildren();return;}
    const groups=groupAiWork(projection.tasks,grouping.value,tag.value),visible=groups.flatMap(g=>g.tasks);
    const reports=projection.reports;
    const needs=projection.tasks.filter(t=>t.needsUser===true).length,needsKnown=projection.tasks.every(t=>t.needsUser!==null);
    const reportedRunning=projection.tasks.filter(t=>reports.some(r=>(t.runTaskKeys||[t.taskKey]).includes(r.taskKey)&&r.status==='running')).length;
    counts.textContent=`Задач: ${projection.tasks.length} · Активных: неизвестно · Running в последних отчётах: ${reportedRunning} · Нужен я: ${needsKnown?needs:'неизвестно'} · Показано: ${visible.length}`;
    notice.textContent='Live worker source не подключён; текущее исполнение и actual model неизвестны. Ниже — последние отчёты, не подтверждение текущей работы.';
    list.replaceChildren();
    for(const group of groups){
      const title=doc.createElement('h3');title.textContent=`${group.name} · ${group.tasks.length}`;const rows=doc.createElement('ul');list.append(title,rows);
      for(const task of group.tasks){
        const item=doc.createElement('li');item.dataset.aiTask=task.taskKey;
        const open=doc.createElement('button');open.type='button';open.textContent=task.title;open.addEventListener('click',()=>{if(!disposed)onOpenTask(task.taskKey);});item.append(open);
        if(task.needsUser===true){const badge=doc.createElement('strong');badge.textContent='Нужен я';item.append(badge);}
        const matches=reports.filter(r=>(task.runTaskKeys||[task.taskKey]).includes(r.taskKey)).sort((a,b)=>(Date.parse(b.receivedAt)||0)-(Date.parse(a.receivedAt)||0)||(b.receivedOrder||0)-(a.receivedOrder||0));
        const report=matches[0],facts=doc.createElement('p');
        facts.textContent=report ? `${states[report.status]||'Статус отчёта неизвестен'} · reported: ${report.agent||'исполнитель не сообщён'} / ${report.model||'модель не сообщена'} · этап: ${report.stage||'не сообщён'} · получен: ${report.receivedAt||'время не сообщено'} · актуальность: ${report.freshness||'unknown'}${matches.length>1?` · попыток: ${matches.length}`:''}` : 'Отчёт исполнителя отсутствует. Исполнение и модель неизвестны.';
        item.append(facts);
        const result=doc.createElement('p');result.textContent=task.resultVersion ? `Результат v${task.resultVersion} · ${task.reviewState==='awaiting_review'?'На приёмке':task.reviewState==='accepted'?'Принят':task.reviewState==='awaiting_dispatch'?'Ожидает передачи':'состояние неизвестно'}` : 'Результат не получен';item.append(result);
        const progress=doc.createElement('p');progress.textContent='Численный прогресс не сообщён';item.append(progress);
        if(task.tags.length){const tags=doc.createElement('span');tags.textContent=task.tags.map(t=>t.name).join(' · ');item.append(tags);}
        rows.append(item);
      }
    }
    if(!visible.length){const empty=doc.createElement('p');empty.textContent=tag.value?'По тегу задач нет.':'Источник вернул пустой список ИИ-задач.';list.append(empty);}
  }
  async function load(){
    if(disposed||busy)return;
    if(!read){unknown();refresh.disabled=true;grouping.disabled=tag.disabled=true;return;}
    busy=true;refresh.disabled=true;section.setAttribute('aria-busy','true');
    if(!projection) counts.textContent='Активных: неизвестно · Нужен я: неизвестно';
    notice.textContent='Загружаем данные ИИ-работ…';
    try{
      const value=await read();if(disposed)return;
      if(!Array.isArray(value?.tasks)||!Array.isArray(value?.reports))throw Error('Invalid source');
      groupAiWork(value.tasks); // Reject duplicate identities rather than double-counting.
      if(value.reports.some(r=>typeof r.taskKey!=='string'||!states[r.status]))throw Error('Invalid report');
      projection=structuredClone(value);
      const selected=tag.value;tag.replaceChildren();const all=doc.createElement('option');all.value='';all.textContent='Все теги';tag.append(all);
      const tags=new Map();for(const task of projection.tasks)for(const t of task.tags)tags.set(t.id,t.name);
      for(const [id,name]of tags){const option=doc.createElement('option');option.value=id;option.textContent=name;tag.append(option);}tag.value=tags.has(selected)?selected:'';paint();
    }catch{if(!disposed){projection=null;unknown();notice.textContent='Данные ИИ-работ недоступны. Это не означает, что работа завершена или задач нет.';list.replaceChildren();}}
    finally{busy=false;if(!disposed){refresh.disabled=false;section.removeAttribute('aria-busy');}}
  }
  grouping.addEventListener('change',paint);tag.addEventListener('change',paint);refresh.addEventListener('click',()=>void load());void load();
  return ()=>{disposed=true;section.remove();};
}

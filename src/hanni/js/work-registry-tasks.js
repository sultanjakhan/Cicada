import {createRegistryStore,freshness} from './work-registry.js';
import {loadDataSources} from './data-sources.js';
import {registryStatusLabel,registryFreshnessLabel} from './work-registry-labels.js';
export function renderRegistryHierarchy(host,snapshots){
  const d=host.ownerDocument;host.replaceChildren();
  for(const s of snapshots){
    const source=d.createElement('p');source.textContent=`Импортированный снимок • ${s.source.publisherId} • ${s.publishedAt} • версия ${s.sequence}. Не live.`;host.append(source);
    for(const project of s.projects){
      const heading=d.createElement('h4');heading.textContent=project.title;host.append(heading);
      const nodes=s.tasks.filter(t=>t.projectId===project.id),children=new Map();
      for(const t of nodes){const key=t.parentTaskId??'';if(!children.has(key))children.set(key,[]);children.get(key).push(t);}
      function branch(parent,depth){const list=d.createElement('ul');for(const t of children.get(parent)||[]){
        const row=d.createElement('li'),details=d.createElement('details'),summary=d.createElement('summary');details.open=depth===0;
        const age=freshness(s,t);summary.textContent=`${t.title} — ${registryStatusLabel(t.status)}${t.relationship==='parallel'?' • параллельно':t.relationship==='sequential'?' • последовательно':''} • ${registryFreshnessLabel(age)}`;
        const provenance=d.createElement('p');provenance.textContent=`Подтверждено ${t.lastUpdated} • ${t.provenance.reference}`;details.append(summary,provenance);
        for(const [k,label] of [['operation','Операция'],['waitingFor','Ожидание'],['result','Результат']])if(t[k]){const p=d.createElement('p');p.textContent=`${label}: ${t[k]}`;details.append(p);}
        if(children.has(t.id))details.append(branch(t.id,depth+1));row.append(details);list.append(row);
      }return list;}
      host.append(branch('',0));
    }
  }
  if(!snapshots.length){const p=d.createElement('p');p.textContent='Опубликованные снимки ещё не импортированы.';host.append(p);}
}

export function mountRegistrySources(host,{invoke,taskHost=host}){
  const d=host.ownerDocument,w=d.defaultView;let disposed=false,revision=0;
  const projects=d.createElement('section'),tasks=d.createElement('section'),projectTitle=d.createElement('h3'),taskTitle=d.createElement('h3');projects.className=tasks.className='work-registry-section';projectTitle.textContent='Projects • импортированные работы';taskTitle.textContent='Tasks • импортированные работы';host.append(projects);taskHost.prepend(tasks);
  async function load(){const rev=++revision;try{const [config,all]=await Promise.all([loadDataSources(invoke),createRegistryStore(invoke).load()]);if(disposed||rev!==revision)return;
    projects.replaceChildren(projectTitle);tasks.replaceChildren(taskTitle);projects.hidden=tasks.hidden=true;
    for(const source of config.sources.filter(s=>s.visible)){
      const section=d.createElement('details'),title=d.createElement('summary');title.textContent=`${source.appId} • источник данных`;section.open=source.appId==='cicada';
      const info=d.createElement('p');info.textContent=source.path?`Папка: ${source.path}. Последняя проверка структуры неизвестна.`:'Папка не задана. Импортированные снимки доступны независимо от папки.';
      const refresh=d.createElement('button');refresh.type='button';refresh.textContent=`Обновить проверку ${source.appId}`;refresh.disabled=!source.path;
      refresh.addEventListener('click',async()=>{refresh.disabled=true;try{const report=await invoke('inspect_data_source',{path:source.path});if(!disposed&&rev===revision)info.textContent=`${report.path} • проверено ${report.inspectedAt} • ${report.entries.map(e=>`${e.name}: ${e.exists?'есть':'нет'}`).join(' • ')}. Содержимое не импортировано; Git не синхронизирован.`;}catch{if(!disposed&&rev===revision)info.textContent='Ошибка проверки структуры. Данные и статус задач не изменены.';}finally{if(!disposed&&rev===revision)refresh.disabled=false;}});
      section.append(title,info,refresh);
      if(source.appId==='cicada'){const registry=d.createElement('div');renderRegistryHierarchy(registry,Object.values(all));section.append(registry);}else{const p=d.createElement('p');p.textContent='Автоматический dispatch и чтение Agent City не подключены. Неизвестные расходы не подставляются.';section.append(p);}
      const placement=source.placement==='tasks'?tasks:projects;placement.hidden=false;placement.append(section);
    }
  }catch{if(!disposed&&rev===revision)projects.textContent='Источники или рабочий реестр недоступны. Повтори открытие задач.';}}
  const refresh=()=>void load();w.addEventListener('hanni:data-sources-changed',refresh);w.addEventListener('hanni:work-registry-changed',refresh);void load();
  return()=>{disposed=true;revision++;tasks.remove();projects.remove();w.removeEventListener('hanni:data-sources-changed',refresh);w.removeEventListener('hanni:work-registry-changed',refresh);};
}

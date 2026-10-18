import { createUiCopy } from './ui-copy.js';
import { registryStatusLabel, registryFreshnessLabel } from './work-registry-labels.js';
import { createRegistryStore, validateRegistry, freshness, registryPreviewIssues, REGISTRY_KEY } from './work-registry.js';

export function mountWorkRegistry(host, { invoke }) {
  const d = host.ownerDocument;
  let selectedMode=false,selection=null,lastRead=null,lastReadName='',previewRevision='',previewSources='';
  const store=createRegistryStore(async(command,args)=>{
    if(command==='set_ui_state'&&selectedMode){
      if(!selection||!lastRead)throw Error('source_grant_unavailable');
      return invoke('commit_registry_source',{grantId:selection.grantId,expectedDigest:lastRead.digest,value:args.value,expectedValue:args.expectedValue,expectedSources:previewSources});
    }
    return invoke(command,args);
  });
  const copy = createUiCopy(d);
  let disposed = false, preview = null, busy = false, draftGeneration = 0;
  const root = d.createElement('details'), summary = d.createElement('summary'); summary.textContent = copy("Импортированный рабочий реестр");
  root.className='registry-source-settings';
  const hint = d.createElement('p'); hint.textContent = copy("Снимки engineering-задач, опубликованные родителем. Это не live-поток и не запуск исполнителя.");
  const label = d.createElement('label'); label.textContent = copy("JSON снимка");
  const input = d.createElement('textarea'); input.rows = 5; input.maxLength = 1048576; label.append(input);
  const check = d.createElement('button'); check.type = 'button'; check.textContent = copy("Предварительный просмотр");
  const save = d.createElement('button'); save.type = 'button'; save.textContent = copy("Импортировать просмотренный снимок"); save.disabled = true;
  const status = d.createElement('p'); status.setAttribute('role','status');
  const choose=d.createElement('button');choose.type='button';choose.textContent='Выбрать опубликованный JSON снимок';
  const revoke=d.createElement('button');revoke.type='button';revoke.textContent='Отозвать чтение файла';revoke.disabled=true;
  const readState=d.createElement('p');readState.textContent='Последнее чтение файла: неизвестно. Сохранённый снимок не означает подключение.';
  const mappings=d.createElement('table');mappings.className='registry-field-map';mappings.setAttribute('aria-label','Поддерживаемые поля источника');
  const headers=d.createElement('tr');for(const title of ['Поле задачи','Поле v1 источника','Правило / значение по умолчанию']){const th=d.createElement('th');th.textContent=title;headers.append(th);}mappings.append(headers);
  for(const [target,path,rule] of [['ID','tasks.id','Обязательный стабильный ID; не генерируется'],['Название','tasks.title','Обязательно; нет подстановки по ID'],['Статус','tasks.status','Явное значение v1; unknown означает неизвестно, done — наблюдение, не приёмка'],['Проект задачи','tasks.projectId','Обязательная ссылка на projects.id'],['ID проекта','projects.id','Обязательный уникальный ID'],['Пространство источника','source.sourceNamespace','Обязательный стабильный UUID; не меняется при обновлении']]){const row=d.createElement('tr');for(const text of [target,path,rule]){const td=d.createElement('td');td.textContent=text;row.append(td);}mappings.append(row);}
  const issues=d.createElement('ul');issues.setAttribute('aria-label','Ошибки записей');
  function invalidate(){draftGeneration++;preview=null;save.disabled=true;}
  function failure(){invalidate();readState.textContent=`Последнее успешное чтение: ${lastRead?.readAt||'неизвестно'}. Текущее чтение недоступно; актуальность неизвестна.`;status.textContent='Чтение или подтверждение не удалось. Черновик сохранён. Для файла требуется новый явный выбор.';}
  async function release(){const old=selection;selection=null;if(old)await invoke('revoke_registry_source',{grantId:old.grantId});revoke.disabled=true;}
  choose.addEventListener('click',async()=>{
    if(busy)return;busy=true;choose.disabled=input.disabled=true;
    try{const picked=await invoke('choose_registry_source');if(!picked)return;if(disposed){await invoke('revoke_registry_source',{grantId:picked.grantId});return;}selectedMode=true;selection=picked;invalidate();revoke.disabled=false;
      const read=await invoke('read_registry_source',{grantId:picked.grantId});if(disposed)return;lastRead=read;lastReadName=picked.fileName;input.value=read.raw;readState.textContent=`Прочитан выбранный снимок ${lastReadName}: ${read.readAt}. Ручной снимок, не live. Разрешение временное.`;status.textContent='Файл прочитан. Проверь поля и предпросмотр перед подтверждением.';
    }catch{selectedMode=true;await release().catch(()=>{});failure();}finally{busy=false;if(!disposed)choose.disabled=input.disabled=false;}
  });
  revoke.addEventListener('click',async()=>{if(busy)return;await release().catch(()=>{});invalidate();failure();});
  const list = d.createElement('div'); list.setAttribute('aria-label',copy("Импортированные работы"));
  function render(snapshots) {
    list.replaceChildren();
    for (const s of snapshots) {
      const source = d.createElement('p'); source.textContent = `${copy("Источник: ")}${s.source.publisherId} • namespace ${s.source.sourceNamespace}${copy(" • опубликован ")}${s.publishedAt}${copy(" • снимок ")}${s.sequence}`; list.append(source);const projects=d.createElement('p');projects.textContent='projects.id: '+s.projects.slice(0,20).map(p=>p.id+' — '+p.title).join(' • ');list.append(projects);
      const ol = d.createElement('ul');
      for (const t of s.tasks.slice(0,20)) {
        const row = d.createElement('li');
        row.textContent = `${t.title} — ${registryStatusLabel(t.status, d.documentElement.lang)} • ${registryFreshnessLabel(freshness(s,t), d.documentElement.lang)} • ${t.lastUpdated} • ID ${t.id} • projectId ${t.projectId}${t.parentTaskId ? `${copy(" • подзадача ")}${t.parentTaskId}, ${t.relationship}` : ''}${copy(" • источник: ")}${t.provenance.reference}`;
        for (const [key,title] of [['operation',copy("Операция")],['waitingFor',copy("Ожидает")],['result',copy("Результат")]]) if (t[key]) { const p = d.createElement('p'); p.textContent = `${title}: ${t[key]}`; row.append(p); }
        ol.append(row);
      }
      list.append(ol);if(s.tasks.length>20){const more=d.createElement('p');more.textContent=`Показано 20 из ${s.tasks.length}. Подтверждение сохраняет полный проверенный снимок.`;list.append(more);}
    }
  }
  input.addEventListener('input',invalidate);
  check.addEventListener('click',async()=>{
    if(busy)return;busy=true;check.disabled=true;invalidate();issues.replaceChildren();
    const generation=draftGeneration,raw=input.value,mode=selectedMode,grantId=selection?.grantId;
    const current=()=>!disposed&&generation===draftGeneration&&raw===input.value&&mode===selectedMode&&grantId===selection?.grantId;
    try{
      if(selectedMode){if(!selection||!lastRead)throw Error('source_grant_unavailable');const read=await invoke('read_registry_source',{grantId,expectedDigest:lastRead.digest});if(!current())return;if(read.raw!==raw)throw Error('edited_source_draft');lastRead=read;}
      const errors=registryPreviewIssues(raw);for(const error of errors){const li=d.createElement('li');li.textContent=error;issues.append(li);}if(errors.length)throw Error('invalid_snapshot');
      const next=validateRegistry(raw);
      const [revision,sources]=await Promise.all([invoke('get_ui_state',{key:REGISTRY_KEY}),invoke('get_ui_state',{key:'cicada_data_sources_v1'})]);
      if(!current())return;previewRevision=revision??'';previewSources=sources??'';preview=next;render([preview]);status.textContent=copy('Предпросмотр. Данные ещё не сохранены.');save.disabled=false;
    }catch{if(!current())return;invalidate();if(selectedMode&&!issues.children.length){await release().catch(()=>{});failure();}else status.textContent=issues.children.length?'Исправь указанные записи; ничего не сохранено.':'Предпросмотр недоступен или устарел. Черновик сохранён; выбери файл заново либо проверь JSON.';}
    finally{busy=false;if(!disposed)check.disabled=false;}
  });
  save.addEventListener('click',async()=>{
    if(!preview||busy)return;busy=true;save.disabled=check.disabled=input.disabled=choose.disabled=revoke.disabled=true;
    try{
      const result=await store.import(JSON.stringify(preview),{expectedValue:previewRevision,verifyReplay:selectedMode});
      if(!disposed){render(Object.values(await store.load()));status.textContent=result.changed?'Снимок сохранён. Нативные задачи, приёмка и таймеры не изменены.':'Этот снимок уже сохранён.';invalidate();d.defaultView.dispatchEvent(new d.defaultView.CustomEvent('hanni:work-registry-changed'));}
    }catch{if(selectedMode){await release().catch(()=>{});if(!disposed)failure();}else if(!disposed){invalidate();status.textContent=copy('Импорт не подтверждён. Проверь sequence или перечитай состояние.');}}
    finally{busy=false;if(!disposed){check.disabled=input.disabled=choose.disabled=false;revoke.disabled=!selection;save.disabled=!preview;}}
  });
  root.append(summary,hint,choose,revoke,readState,mappings,label,check,issues,save,status,list); host.append(root);
  void store.load().then(all => { if (!disposed && !preview) render(Object.values(all)); }, () => { if (!disposed) status.textContent = copy("Сохранённый реестр недоступен. Импорт не выполнялся."); });
  return () => { disposed = true;void release().catch(()=>{}); };
}

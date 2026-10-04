export const DATA_SOURCES_KEY = 'cicada_data_sources_v1';
export const defaultDataSources = () => ({schemaVersion:1,appId:'cicada',sources:[{appId:'cicada',path:null,localGit:false,visible:true,placement:'projects'},{appId:'agent-city',path:null,localGit:false,visible:true,placement:'projects'}],refresh:{mode:'manual'},onboarding:{status:'skipped'}});
export function validateDataSources(value) {
  const defaults = defaultDataSources();
  if (!value || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(Object.keys(defaults).sort()) || value.schemaVersion !== 1 || value.appId !== 'cicada' || JSON.stringify(value.refresh) !== JSON.stringify(defaults.refresh) || !['skipped','configured'].includes(value.onboarding?.status) || Object.keys(value.onboarding).length !== 1 || !Array.isArray(value.sources) || value.sources.length !== 2) throw Error('invalid_data_sources');
  for (let i=0;i<2;i++) {
    const s=value.sources[i];
    if (!s || Object.keys(s).sort().join() !== 'appId,localGit,path,placement,visible' || s.appId !== defaults.sources[i].appId || typeof s.visible !== 'boolean' || typeof s.localGit !== 'boolean' || !['projects','tasks'].includes(s.placement) || (s.path !== null && (typeof s.path !== 'string' || s.path.length > 1024 || !/^(?:[A-Za-z]:[\\/]|\\\\)/.test(s.path) || /[\u0000-\u001f]/.test(s.path)))) throw Error('invalid_data_sources');
  }
  return value;
}
export function mountDataSources(host,{invoke}) {
  const d=host.ownerDocument; let disposed=false,raw='',state=defaultDataSources();
  const root=d.createElement('details'),heading=d.createElement('summary');root.className='data-source-settings';heading.textContent='Данные и источники';
  const hint=d.createElement('p');hint.textContent='Выбери папку и проверь структуру перед сохранением. Файлы не читаются, данные не переносятся. Видимость и размещение применяются к разделам источников в области задач. Автоматического обмена нет.';
  const fields=d.createElement('div'),status=d.createElement('p');status.setAttribute('role','status');
  const save=d.createElement('button');save.type='button';save.textContent='Сохранить источники';save.disabled=true;
  const preview=d.createElement('pre');preview.textContent='Предлагаемая структура:\n<app>-data/manifest.json\n<app>-data/projects/\n<app>-data/tasks/\n<app>-data/runs/\nCredentials и sessions хранятся отдельно.\nGit local/private — предпочтение, репозиторий не создан.';
  const rows=[];
  for(const source of state.sources){
    const section=d.createElement('fieldset'),title=d.createElement('legend');title.textContent=source.appId;
    const label=d.createElement('label');label.textContent='Абсолютный путь к папке';const path=d.createElement('input');path.type='text';path.maxLength=1024;label.append(path);
    const choose=d.createElement('button');choose.type='button';choose.textContent=`Выбрать папку ${source.appId}`;
    const inspect=d.createElement('button');inspect.type='button';inspect.textContent=`Проверить папку ${source.appId}`;
    const inspection=d.createElement('p');inspection.setAttribute('role','status');inspection.textContent='Папка не проверена.';
    let inspectedPath=null;
    const checkPath=async()=>{inspectedPath=null;inspect.disabled=choose.disabled=true;try{const report=await invoke('inspect_data_source',{path:path.value.trim()});if(!disposed){inspectedPath=path.value.trim();inspection.textContent=`Проверено ${report.inspectedAt}: ${report.entries.map(e=>`${e.name}: ${e.exists?'есть':'нет'}`).join(' • ')}. Только метаданные; содержимое не импортировано.`;}}catch{if(!disposed)inspection.textContent='Проверка не удалась: требуется существующая локальная папка без ссылок и неверных типов. Содержимое не читалось.';}finally{if(!disposed)inspect.disabled=choose.disabled=false;}};
    path.addEventListener('input',()=>{inspectedPath=null;inspection.textContent='Путь изменён. Проверь папку перед сохранением.';});
    inspect.addEventListener('click',()=>void checkPath());
    choose.addEventListener('click',async()=>{choose.disabled=true;try{const picked=await invoke('choose_data_source');if(picked&&!disposed){path.value=picked;await checkPath();}}catch{if(!disposed)inspection.textContent='Выбор папки недоступен. Введи абсолютный путь и проверь его.';}finally{if(!disposed)choose.disabled=false;}});
    const visibleLabel=d.createElement('label'),visible=d.createElement('input');visible.type='checkbox';visibleLabel.append(visible,d.createTextNode('Показывать раздел'));
    const gitLabel=d.createElement('label'),git=d.createElement('input');git.type='checkbox';gitLabel.append(git,d.createTextNode('Предпочитать локальный private Git'));
    const placeLabel=d.createElement('label');placeLabel.textContent='Размещение';const place=d.createElement('select');for(const [v,t] of [['tasks','Tasks • перед локальными задачами'],['projects','Projects • после локальных задач']]){const o=d.createElement('option');o.value=v;o.textContent=t;place.append(o);}placeLabel.append(place);
    section.className='data-source-setting';
    label.className=placeLabel.className='data-source-field';
    visibleLabel.className=gitLabel.className='calendar-settings-toggle';
    const actions=d.createElement('div');actions.className='calendar-sync-actions';actions.append(choose,inspect);
    section.append(title,label,actions,inspection,visibleLabel,gitLabel,placeLabel);fields.append(section);rows.push({path,visible,git,place,isInspected:()=>inspectedPath===path.value.trim()});
  }
  function paint(){rows.forEach((r,i)=>{const s=state.sources[i];r.path.value=s.path??'';r.visible.checked=s.visible;r.git.checked=s.localGit;r.place.value=s.placement;});}
  save.addEventListener('click',async()=>{
    save.disabled=true;
    try{if(rows.some((r,i)=>r.path.value.trim()&&r.path.value.trim()!==state.sources[i].path&&!r.isInspected()))throw Error('inspection_required');const next=validateDataSources({...state,sources:state.sources.map((s,i)=>({...s,path:rows[i].path.value.trim()||null,visible:rows[i].visible.checked,localGit:rows[i].git.checked,placement:rows[i].place.value})),onboarding:{status:'configured'}});for(const source of next.sources)if(source.path)await invoke('inspect_data_source',{path:source.path});const value=JSON.stringify(next);await invoke('set_ui_state',{key:DATA_SOURCES_KEY,value,expectedValue:raw});raw=value;state=next;if(!disposed){status.textContent='Настройки сохранены. Разделы источников обновлены. Файлы не импортированы; режим ручной.';d.defaultView.dispatchEvent(new d.defaultView.CustomEvent('hanni:data-sources-changed'));}}
    catch{if(!disposed)status.textContent='Сохранение не подтверждено. Проверь абсолютные пути или открой настройки заново.';}
    finally{if(!disposed)save.disabled=false;}
  });
  root.append(heading,hint,fields,preview,save,status);host.append(root);
  void invoke('get_ui_state',{key:DATA_SOURCES_KEY}).then(value=>{if(disposed)return;raw=value??'';state=raw?validateDataSources(JSON.parse(raw)):defaultDataSources();paint();save.disabled=false;status.textContent=raw?'Настройки загружены. Источники не проверены; автоматического обновления нет.':'Источники не настроены. Можно пропустить и вернуться позже.';}).catch(()=>{if(!disposed)status.textContent='Настройки недоступны; сохранение заблокировано.';});
  return()=>{disposed=true;};
}

export async function loadDataSources(invoke){const raw=await invoke('get_ui_state',{key:DATA_SOURCES_KEY});return raw?validateDataSources(JSON.parse(raw)):defaultDataSources();}

export function mountSourceOnboarding(host,{invoke,onSettings}){
  const d=host.ownerDocument;let disposed=false,node=null;
  void Promise.all([invoke('get_ui_state',{key:'cicada_sources_onboarding_eligible_v1'}),invoke('get_ui_state',{key:DATA_SOURCES_KEY})]).then(([eligible,configured])=>{
    if(disposed||eligible!=='true'||configured)return;
    const section=d.createElement('section'),title=d.createElement('h3'),hint=d.createElement('p');title.textContent='Подключить папки данных?';hint.textContent='Можно настроить локальные источники сейчас или пропустить. Задачи доступны без подключения.';
    section.className='source-onboarding';
    node=section;
    const setup=d.createElement('button'),skip=d.createElement('button');setup.type=skip.type='button';setup.textContent='Настроить источники';skip.textContent='Пропустить';
    setup.className='btn-primary';skip.className='btn-secondary';
    const actions=d.createElement('div');actions.className='source-onboarding-actions';actions.append(setup,skip);
    const dismiss=async(open)=>{setup.disabled=skip.disabled=true;try{await invoke('set_ui_state',{key:DATA_SOURCES_KEY,value:JSON.stringify(defaultDataSources()),expectedValue:''});if(!disposed){section.remove();if(open)onSettings();}}catch{if(!disposed){hint.textContent='Не удалось сохранить выбор. Повтори позже.';setup.disabled=skip.disabled=false;}}};
    setup.addEventListener('click',()=>void dismiss(true));skip.addEventListener('click',()=>void dismiss(false));section.append(title,hint,actions);host.prepend(section);
  }).catch(()=>{});
  return()=>{disposed=true;node?.remove();};
}

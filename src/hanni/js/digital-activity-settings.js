import { listen } from './state.js';
import { escapeHtml } from './utils.js';

const esc=value=>escapeHtml(String(value??''));
const fallbackPort=5600;
function timeLabel(value){if(!value)return 'Импорт ещё не выполнялся';const time=new Date(value);return Number.isFinite(time.getTime())?`Последний успешный импорт · ${time.toLocaleString('ru-RU')}`:'Последний импорт отмечен';}
function errorLabel(value){const known={digital_activity_invalid_config:'Проверь название и локальный порт.',digital_activity_invalid_source:'Выбери Windows или Android.',digital_activity_unredacted_title:'Источник передал заголовок окна. Убери его в настройках ActivityWatch и повтори импорт.',digital_activity_invalid_date:'Выбери корректную дату.'};return known[value]||'Импорт не завершён. Проверь, что ActivityWatch запущен на этом устройстве, и повтори попытку.';}

export function mountDigitalActivitySettings(element,{invoke,setPending=()=>{}}={}){
  const window=element.ownerDocument.defaultView;
  let disposed=false,busy=false,devices=[],loadError='',message='',editingId=null,formBaseline=null;
  element.className='calendar-setting digital-activity-settings';
  element.innerHTML=`<h3>Локальный учёт приложений</h3><p class="calendar-setting-hint">Подключи ActivityWatch на этом устройстве, чтобы добавлять дневные итоги в календарь. В календарь попадут названия приложений и время, без заголовков окон и адресов страниц.</p><p data-da-error role="alert" hidden></p><p data-da-message role="status" hidden></p><div data-da-list></div><button type="button" data-da-add>Добавить устройство</button><button type="button" data-da-retry hidden>Повторить загрузку</button><section data-da-form hidden><h4 data-da-form-title>Новое устройство</h4><label>Название устройства<input data-da-label maxlength="100" autocomplete="off"></label><label>Система<select data-da-source><option value="windows">Windows</option><option value="android">Android</option></select></label><label class="digital-activity-settings__toggle"><input type="checkbox" data-da-enabled> Автоматически обновлять календарь</label><details><summary>Подключение</summary><label>Локальный порт<input type="number" data-da-port min="1" max="65535" value="${fallbackPort}"></label><p>Только локальный ActivityWatch на этом устройстве.</p></details><label>Токен, если настроен<input type="password" data-da-token autocomplete="new-password" placeholder="Оставь пустым, чтобы не менять"></label><label data-da-token-clear-wrap hidden><input type="checkbox" data-da-token-clear> Удалить сохранённый токен</label><div class="digital-activity-settings__actions"><button type="button" data-da-save>Сохранить подключение</button><button type="button" data-da-cancel>Отмена</button></div></section><section class="digital-activity-settings__blockers"><h3>Ограничение приложений и сайтов</h3><p>Блокировщики настраиваются в своих приложениях. Управление из Cicada ещё не подключено.</p><article><h4>Android · TimeLimit</h4><p>Стороннее приложение для правил использования приложений.</p><a href="https://codeberg.org/timelimit/opentimelimit-android" data-open-url="https://codeberg.org/timelimit/opentimelimit-android" target="_blank" rel="noopener noreferrer">Открыть исходный проект</a></article><article><h4>Браузер · LeechBlock NG</h4><p>Расширение для расписания блокировки сайтов в поддерживаемом браузере.</p><a href="https://github.com/proginosko/LeechBlockNG" data-open-url="https://github.com/proginosko/LeechBlockNG" target="_blank" rel="noopener noreferrer">Открыть исходный проект</a></article><p>Блокирование приложений Windows из Cicada пока не поддерживается.</p></section>`;
  const q=selector=>element.querySelector(selector),error=q('[data-da-error]'),statusMessage=q('[data-da-message]'),list=q('[data-da-list]'),form=q('[data-da-form]');
  const showError=value=>{error.textContent=value;error.hidden=!value;};
  function render(){
    if(disposed)return;
    list.innerHTML=devices.length?devices.map(device=>`<article class="digital-activity-device" data-device-id="${esc(device.id)}"><div class="digital-activity-device__heading"><div><h4>${esc(device.label)}</h4><p>${device.source==='android'?'Android':'Windows'} · порт ${esc(device.port)}</p></div><span class="digital-activity-device__state ${device.lastError?'is-error':device.enabled?'is-enabled':'is-paused'}">${device.lastError?'Проверь подключение':device.enabled?'Автоимпорт включён':'Автоимпорт на паузе'}</span></div><p>${device.lastError?errorLabel(device.lastError):timeLabel(device.lastSuccess)}</p><p>Записей активности · ${Number(device.records)||0}</p><div class="digital-activity-settings__actions"><button type="button" data-da-import="${esc(device.id)}">Импортировать сейчас</button><button type="button" data-da-edit="${esc(device.id)}">Изменить</button><button type="button" data-da-toggle="${esc(device.id)}">${device.enabled?'Приостановить автоимпорт':'Включить автоимпорт'}</button></div></article>`).join(''):'<p>Подключения пока нет. Устройство и автоимпорт настраиваются отдельно; новые профили не подключаются автоматически.</p>';
    q('[data-da-retry]').hidden=!loadError;
    element.querySelectorAll('button').forEach(button=>{button.disabled=busy;});
    if(loadError)showError(loadError);
  }
  function openForm(device=null){
    editingId=device?.id||null;
    q('[data-da-form-title]').textContent=device?'Изменить подключение':'Новое устройство';
    q('[data-da-label]').value=device?.label||'';q('[data-da-source]').value=device?.source||'windows';q('[data-da-enabled]').checked=device?.enabled??false;q('[data-da-port]').value=String(device?.port||fallbackPort);q('[data-da-token]').value='';q('[data-da-token-clear]').checked=false;q('[data-da-token-clear-wrap]').hidden=!device;
    formBaseline={id:editingId,label:q('[data-da-label]').value,source:q('[data-da-source]').value,enabled:q('[data-da-enabled]').checked,port:q('[data-da-port]').value,token:'',clearToken:false};
    form.hidden=false;q('[data-da-label]').focus();
  }
  function isDirty(){if(form.hidden||!formBaseline)return false;return JSON.stringify({id:editingId,label:q('[data-da-label]').value.trim(),source:q('[data-da-source]').value,enabled:q('[data-da-enabled]').checked,port:q('[data-da-port]').value,token:q('[data-da-token]').value,clearToken:q('[data-da-token-clear]').checked})!==JSON.stringify({...formBaseline,label:formBaseline.label.trim()});}
  async function load(){
    if(busy||disposed)return;busy=true;render();
    try{const value=await invoke('digital_activity_status');if(disposed)return;devices=Array.isArray(value?.devices)?value.devices:[];loadError='';showError('');}
    catch(err){if(!disposed){loadError=err?.message||'Не удалось загрузить подключения.';showError(loadError);}}
    finally{busy=false;render();}
  }
  async function perform(action){
    if(busy||disposed)return;busy=true;setPending(true);message='';statusMessage.hidden=true;showError('');render();
    try{await action();if(!disposed){loadError='';await reloadAfterAction();}}
    catch(err){if(!disposed)showError(errorLabel(err?.message)||'Операция не завершена. Проверь подключение и повтори попытку.');}
    finally{busy=false;if(!disposed){setPending(false);render();}}
  }
  async function reloadAfterAction(){try{const value=await invoke('digital_activity_status');devices=Array.isArray(value?.devices)?value.devices:[];loadError='';}catch(err){loadError=err?.message||'Не удалось обновить состояние подключения.';}}
  async function save(device=null){
    const label=q('[data-da-label]').value.trim(),port=Number(q('[data-da-port]').value);
    if(!label||label.length>100){showError('Укажи название от 1 до 100 символов.');q('[data-da-label]').focus();return;}
    if(!Number.isInteger(port)||port<1||port>65535){showError('Укажи локальный порт от 1 до 65535.');q('[data-da-port]').focus();return;}
    const token=q('[data-da-token]').value,clearToken=q('[data-da-token-clear]').checked;
    const input={id:editingId||undefined,label,port,enabled:q('[data-da-enabled]').checked,source:q('[data-da-source]').value};
    if(token)input.token=token;else if(clearToken)input.token='';
    await perform(async()=>{await invoke('digital_activity_save_connection',{input});form.hidden=true;formBaseline=null;q('[data-da-token]').value='';message='Подключение сохранено.';statusMessage.textContent=message;statusMessage.hidden=false;});
  }
  async function importNow(id){
    await perform(async()=>{const result=await invoke('digital_activity_import_now',{deviceId:id});const errors=Array.isArray(result?.errors)?result.errors:[];message=errors.length?`${errorLabel(errors[0]?.error)} Состояние подключения обновлено.`:`Импорт завершён · новых или обновлённых дней: ${Number(result?.changed)||0}.`;statusMessage.textContent=message;statusMessage.hidden=false;});
  }
  async function toggle(device){
    const input={id:device.id,label:device.label,port:device.port,endpoint:device.endpoint,enabled:!device.enabled,source:device.source};
    await perform(async()=>{await invoke('digital_activity_save_connection',{input});message=input.enabled?'Автоимпорт включён.':'Автоимпорт приостановлен.';statusMessage.textContent=message;statusMessage.hidden=false;});
  }
  element.addEventListener('click',event=>{
    const button=event.target.closest('button');if(!button||!element.contains(button))return;
    if(busy)return;
    if(isDirty()&&!button.matches('[data-da-save],[data-da-cancel]')){showError('Сначала сохрани или отмени открытый черновик подключения.');return;}
    if(button.hasAttribute('data-da-add'))openForm();
    else if(button.hasAttribute('data-da-cancel')){form.hidden=true;formBaseline=null;showError('');}
    else if(button.hasAttribute('data-da-retry')){loadError='';void load();}
    else if(button.dataset.daEdit)openForm(devices.find(device=>device.id===button.dataset.daEdit));
    else if(button.dataset.daImport)void importNow(button.dataset.daImport);
    else if(button.dataset.daToggle){const device=devices.find(item=>item.id===button.dataset.daToggle);if(device)void toggle(device);}
    else if(button.hasAttribute('data-da-save'))void save();
  });
  const changed=()=>{if(!disposed)render();};element.addEventListener('input',changed);element.addEventListener('change',changed);
  const onUpdated=()=>{if(!disposed){void reloadAfterAction().then(()=>render());}};
  let unlisten;
  try{Promise.resolve(listen('digital-activity-updated',onUpdated)).then(stop=>{if(disposed)stop?.();else unlisten=stop;}).catch(()=>{});}catch{}
  render();void load();
  const dispose=()=>{disposed=true;unlisten?.();element.removeEventListener('input',changed);element.removeEventListener('change',changed);};
  dispose.isDirty=isDirty;return dispose;
}

export function startDigitalActivityRefresh({window,listen,requestSync=()=>{}}){
  let disposed=false,unlisten;
  try{Promise.resolve(listen('digital-activity-updated',event=>{
    if(disposed)return;
    window.dispatchEvent(new window.CustomEvent('hanni:calendar-refresh',{detail:{activity:true,days:event?.payload?.days||[]}}));
    requestSync();
  })).then(stop=>{if(disposed)stop?.();else unlisten=stop;}).catch(()=>{});}catch{}
  return()=>{disposed=true;unlisten?.();};
}

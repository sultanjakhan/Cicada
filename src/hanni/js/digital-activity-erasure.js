import { localDate } from './utils.js';

const errors = {
  digital_activity_invalid_date: 'Выбери существующую дату не позднее сегодняшней.',
  digital_activity_erasure_count_changed: 'Количество итогов изменилось. Проверь период ещё раз перед удалением.',
  digital_activity_erasure_unsafe_record: 'Некоторые записи не удалось однозначно связать с этим подключением. Ничего не удалено.',
};

// The preview belongs to one device/date. Editing or reopening invalidates it;
// background status refreshes never rebuild this form or discard its date.
export function mountDigitalActivityErasure(element, { invoke, onPending=()=>{}, onErased=()=>{}, today=()=>localDate() }={}) {
  let device=null, preview=null, busy=false, disposed=false, revision=0;
  element.hidden=true;
  element.className='digital-activity-erasure';
  element.innerHTML=`<h4 tabindex="-1">Удалить историю</h4><p data-erasure-device></p><label>По какую дату включительно<input type="date" data-erasure-date></label><p class="calendar-setting-hint">Удаляются дневные итоги Cicada. Выбранные дни больше не будут импортироваться для этого подключения. Исходные данные ActivityWatch и резервные копии остаются.</p><p data-erasure-result role="status" hidden></p><p data-erasure-error role="alert" hidden></p><div class="digital-activity-settings__actions"><button type="button" data-erasure-preview>Проверить период</button><button type="button" data-erasure-confirm hidden>Удалить итоги</button><button type="button" data-erasure-cancel>Отмена</button></div>`;
  const q=selector=>element.querySelector(selector), date=q('[data-erasure-date]'), result=q('[data-erasure-result]'), error=q('[data-erasure-error]');
  const showError=text=>{error.textContent=text;error.hidden=!text;};
  function render() {
    if(disposed)return;
    date.disabled=busy;
    q('[data-erasure-preview]').disabled=busy;
    q('[data-erasure-confirm]').hidden=!preview;
    q('[data-erasure-confirm]').disabled=busy||!preview;
    q('[data-erasure-confirm]').textContent=preview?.count===0?'Исключить дни из импорта':'Удалить итоги';
    q('[data-erasure-cancel]').disabled=busy;
  }
  function invalidate() { revision++;preview=null;result.hidden=true;showError('');render(); }
  function calendarDate(value) {
    if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
    const parsed=new Date(`${value}T12:00:00Z`);
    return Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===value;
  }
  const validDate=value=>calendarDate(value)&&value<=today();
  async function perform(action) {
    if(busy||disposed||!device)return;
    busy=true;showError('');onPending(true);render();
    try { await action(); }
    catch(err) { if(!disposed){preview=null;result.hidden=true;showError(errors[err?.message||String(err)]||'Не удалось обработать историю. Ничего не подтверждено; проверь период и повтори попытку.');} }
    finally { busy=false;if(!disposed){onPending(false);render();} }
  }
  q('[data-erasure-preview]').onclick=()=>{
    if(!validDate(date.value)){showError(errors.digital_activity_invalid_date);date.focus();return;}
    const deviceId=device.id,throughDate=date.value,request=revision;
    void perform(async()=>{
      const value=await invoke('digital_activity_preview_erasure',{deviceId,throughDate});
      if(disposed||request!==revision)return;
      if(value?.deviceId!==deviceId||value?.throughDate!==throughDate||!Number.isSafeInteger(value.count)||value.count<0)throw Error('invalid_preview');
      preview={deviceId,throughDate,count:value.count};
      result.textContent=value.count?`Будет удалено дневных итогов: ${value.count}. Последний день — ${throughDate}.`:`До ${throughDate} итогов нет. После подтверждения импорт этих дней будет запрещён.`;
      result.hidden=false;
    });
  };
  q('[data-erasure-confirm]').onclick=()=>{
    if(!preview||preview.deviceId!==device?.id||preview.throughDate!==date.value)return;
    const confirmed={...preview};
    void perform(async()=>{
      const value=await invoke('digital_activity_erase_history',{deviceId:confirmed.deviceId,throughDate:confirmed.throughDate,expectedCount:confirmed.count});
      if(disposed)return;
      // Another timezone/peer may already have advanced this monotone boundary.
      // Only the user's requested date must not be in the local future.
      if(!Number.isSafeInteger(value?.deleted)||value.deleted<0||!calendarDate(value.deletedThrough)||value.deletedThrough<confirmed.throughDate)throw Error('invalid_erasure_result');
      element.hidden=true;revision++;preview=null;
      await onErased(value,confirmed);
    });
  };
  date.addEventListener('input',invalidate);
  date.addEventListener('change',invalidate);
  function close() { if(busy)return;const id=device?.id;invalidate();element.hidden=true;device=null;return id; }
  q('[data-erasure-cancel]').onclick=()=>{const id=close();element.dispatchEvent(new element.ownerDocument.defaultView.CustomEvent('activity-erasure-cancel',{bubbles:true,detail:{deviceId:id}}));};
  return {
    open(value) { if(busy||disposed||!value)return;invalidate();device={id:value.id,label:value.label};q('[data-erasure-device]').textContent=value.label;date.value=today();date.max=today();element.hidden=false;q('h4').focus(); },
    close,
    dispose() { disposed=true;revision++; },
  };
}

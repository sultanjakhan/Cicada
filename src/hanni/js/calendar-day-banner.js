import {projectDayStarts} from './calendar-day-start.js';
import {dateKey} from './calendar-recurring-store.js';
export function mountCalendarDayBanner(element,{invoke,now=()=>new Date()}={}) {
  const document=element.ownerDocument,window=document.defaultView;
  let disposed=false,busy=false,loaded=false,day='',entries=[];
  element.className='calendar-day-banner';
  element.innerHTML='<div class="today-date"><small>Сегодня</small><h2><time></time><span data-weekday></span></h2></div><div><button type="button" data-start-day disabled>Начать день</button><p role="alert" hidden></p></div>';
  const start=element.querySelector('[data-start-day]'),error=element.querySelector('[role=alert]');
  function render(){if(disposed)return;const current=now();day=dateKey(current);element.querySelector('[data-weekday]').textContent=new Intl.DateTimeFormat('ru',{weekday:'long'}).format(current);const time=element.querySelector('time');time.dateTime=day;time.textContent=new Intl.DateTimeFormat('ru',{day:'numeric',month:'long',year:'numeric'}).format(current);const started=entries.find(entry=>entry.date===day);start.textContent=started?'✓ День начат · '+started.time:'Начать день';start.disabled=busy||!loaded||!!started;start.classList.toggle('is-started',!!started);}
  async function read(){const raw=await invoke('get_ui_state',{key:'calendar_day_start_v1'});const parsed=raw?JSON.parse(raw):{version:1,entries:[]};if(!parsed||!Array.isArray(parsed.entries))throw Error('Не удалось прочитать начало дня.');return parsed;}
  async function refresh(){try{const state=await read();entries=projectDayStarts(state);loaded=true;error.hidden=true;}catch(err){error.textContent=err?.message||String(err);error.hidden=false;}render();}
  async function save(){if(busy||!loaded)return;busy=true;render();try{const state=await read();const today=dateKey(now()),existing=projectDayStarts(state).filter(item=>item.date===today);if(!existing.length)state.entries.push({id:crypto.randomUUID(),started_at_utc:now().toISOString()});await invoke('set_ui_state',{key:'calendar_day_start_v1',value:JSON.stringify(state)});entries=projectDayStarts(state);error.hidden=true;window.dispatchEvent(new window.Event('hanni:calendar-refresh'));}catch(err){error.textContent=err?.message||String(err);error.hidden=false;}finally{busy=false;render();}}
  start.onclick=()=>void save();void refresh();
  const timer=window.setInterval(()=>{if(day!==dateKey(now()))void refresh();},30000);
  return ()=>{disposed=true;window.clearInterval(timer);};
}

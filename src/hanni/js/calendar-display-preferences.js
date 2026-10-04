const KEY='calendar_preferences_v1';
export const DEFAULT_CALENDAR_PREFERENCES=Object.freeze({version:1,first_day:'mon',default_view:'Месяц',density:'comfortable',showCompleted:false,recommendationsEnabled:true,recommendTasks:true,recommendRoutines:true});
export function normalizeCalendarPreferences(value={}){if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Повреждённые настройки календаря не были применены.');const p={...DEFAULT_CALENDAR_PREFERENCES,...value};if(!['mon','sun'].includes(p.first_day)||!['Месяц','Неделя','День','Список'].includes(p.default_view)||!['comfortable','compact'].includes(p.density)||!['showCompleted','recommendationsEnabled','recommendTasks','recommendRoutines'].every(key=>typeof p[key]==='boolean'))throw Error('Повреждённые настройки календаря не были применены.');return {...p,default_view:p.default_view==='Список'?'Месяц':p.default_view,version:1};}
const nativeTransport=(command,args)=>window.__TAURI__?.core?.invoke(command,args)||Promise.reject(new Error('Требуется установленная Cicada.'));
export async function loadCalendarPreferences(transport=nativeTransport){const raw=await transport('get_ui_state',{key:KEY});if(raw!==null&&raw!==undefined&&raw!==''){try{return normalizeCalendarPreferences(JSON.parse(raw));}catch(error){throw error;}}const [first_day,default_view]=await Promise.all([transport('get_app_setting',{key:'tab_calendar_first_day'}),transport('get_app_setting',{key:'tab_calendar_default_view'})]);return normalizeCalendarPreferences({...DEFAULT_CALENDAR_PREFERENCES,first_day:first_day??'mon',default_view:default_view??'Месяц'});}
export async function saveCalendarPreferences(value,transport=nativeTransport,options={}){const preferences=normalizeCalendarPreferences(value),raw=await transport('get_ui_state',{key:KEY}),current=raw?normalizeCalendarPreferences(JSON.parse(raw)):await loadCalendarPreferences(transport),base=options.base==null?null:normalizeCalendarPreferences(options.base),next={...current};
  if(base){for(const key of Object.keys(DEFAULT_CALENDAR_PREFERENCES)){const mine=preferences[key]!==base[key],remote=current[key]!==base[key];if(mine&&remote&&current[key]!==preferences[key])throw Error('Настройки изменились на другом устройстве. Проверь конфликтующее поле и сохрани ещё раз.');if(mine)next[key]=preferences[key];}}
  else Object.assign(next,preferences);
  const saved=normalizeCalendarPreferences(next);try{await transport('set_ui_state',{key:KEY,value:JSON.stringify(saved),expectedValue:raw??''});}catch(error){if(String(error?.message||error).includes('mvp_sync_stale_ui_state'))throw Error('Настройки изменились на другом устройстве. Нажми «Сохранить» ещё раз.');throw error;}return saved;}

// The focused Today dialog changes only recommendation fields. Preserve a fresh
// calendar snapshot and reject concurrent writes through the existing CAS API.
export async function saveRecommendationPreferences(value, transport=nativeTransport) {
  const requested=normalizeCalendarPreferences(value);
  const raw=await transport('get_ui_state',{key:KEY});
  const current=raw ? normalizeCalendarPreferences(JSON.parse(raw)) : await loadCalendarPreferences(transport);
  const next={...current};
  for(const key of ['recommendationsEnabled','recommendTasks','recommendRoutines']) if(Object.hasOwn(value,key)) next[key]=requested[key];
  try { await transport('set_ui_state',{key:KEY,value:JSON.stringify(next),expectedValue:raw??''}); }
  catch(error) {
    if(String(error?.message||error).includes('mvp_sync_stale_ui_state')) throw Error('Настройки изменились на другом устройстве. Нажми «Сохранить» ещё раз.');
    throw error;
  }
  return next;
}

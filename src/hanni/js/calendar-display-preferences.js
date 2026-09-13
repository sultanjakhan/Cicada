import { invoke } from './state.js';
const KEY='calendar_preferences_v1';
export const DEFAULT_CALENDAR_PREFERENCES=Object.freeze({version:1,first_day:'mon',default_view:'Месяц',density:'comfortable',showCompleted:false});
function normal(value={}){return {...DEFAULT_CALENDAR_PREFERENCES,first_day:value.first_day==='sun'?'sun':'mon',default_view:['Месяц','Неделя','День','Список'].includes(value.default_view)?value.default_view:'Месяц',density:value.density==='compact'?'compact':'comfortable',showCompleted:value.showCompleted===true};}
export async function loadCalendarPreferences(){const raw=await invoke('get_ui_state',{key:KEY});if(!raw)return {...DEFAULT_CALENDAR_PREFERENCES};try{return normal(JSON.parse(raw));}catch{return {...DEFAULT_CALENDAR_PREFERENCES};}}
export async function saveCalendarPreferences(value){const preferences=normal(value);await invoke('set_ui_state',{key:KEY,value:JSON.stringify(preferences)});return preferences;}

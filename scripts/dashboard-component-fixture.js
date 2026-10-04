import {mountCalendarDashboardTasks} from '../src/hanni/js/calendar-dashboard-tasks.js';
import {mountCalendarNow} from '../src/hanni/js/calendar-now.js';
import {mountCalendarDayBanner} from '../src/hanni/js/calendar-day-banner.js';
import {mountCalendarTodayAction} from '../src/hanni/js/calendar-today-action.js';
import {mountCalendarInProgress} from '../src/hanni/js/calendar-in-progress.js';
import {mountDashboardAiWork} from '../src/hanni/js/dashboard-ai-work.js';
import {mountDashboardWorkViews} from '../src/hanni/js/dashboard-work-views.js';
import {mountThemeControl,placeThemeControlNextToToday} from '../src/hanni/js/theme-control.js';

// QA fixture only: every store/command below is synthetic and stays in memory.
export function mountDashboardComponentFixture(host,{markup,scenario='reports',theme='light',view='ai'}={}){
 const doc=host.ownerDocument,now=new Date(2026,9,4,12,0,0),day='2026-10-04',calls=[],stops=[];
 host.innerHTML=markup;host.classList.add('calendar-workspace');doc.documentElement.dataset.theme=theme;
 const root=host.querySelector('.calendar-today'),banner=root.querySelector('[data-calendar-day-banner]');
 const tasks=[{source_type:'note',source_id:'fixture-personal',title:'Уточнить требования к учебному проекту',sphere:'work',status_extra:'task',date:day,is_active:true,has_work:true,actual_seconds:600,duration_minutes:30}];
 tasks.push({source_type:'note',source_id:'fixture-other-personal',title:'Записать вопросы для учебного проекта',sphere:'work',status_extra:'task',date:day});
 const block={id:1,source_type:'note',source_id:'fixture-personal',title:tasks[0].title,date:day,start_time:'11:50:00',is_active:true};
 let ledger={version:1,entries:[]};const localUI=new Map();
 const invoke=async(name,args)=>{
  calls.push({name,args});
  if(name==='get_calendar_tasks')return structuredClone(tasks);
  if(name==='get_active_blocks')return [structuredClone(block)];
  if(name==='get_timeline_blocks')return [];
  if(name==='get_ui_state')return args?.key==='calendar_day_start_v1'?JSON.stringify(ledger):(localUI.get(args?.key)||null);
  if(name==='set_ui_state'&&args?.key==='calendar_now_v1'){localUI.set(args.key,args.value);return;}
  if(name==='start_calendar_day'){ledger={version:1,entries:[{id:'fixture-day',started_at_utc:'2026-10-04T09:00:00Z'}]};return ledger;}
  if(name.startsWith('get_'))return [];
  throw Error('В QA-макете запись в приложение отключена.');
 };
 const message=doc.createElement('p');message.setAttribute('role','status');host.append(message);
 const tell=text=>{message.textContent=text;};
 stops.push(mountCalendarDayBanner(banner,{invoke,now:()=>now,onOpenSettings:()=>tell('В приложении здесь открываются настройки рекомендаций.')}));
 const upper=doc.createElement('header');upper.className='uni-header';const tools=doc.createElement('div');tools.dataset.calendarTodayControls='';const running=doc.createElement('div');running.dataset.calendarRunning='';tools.append(running);upper.append(tools);host.prepend(upper);
 const goalHost=host.querySelector('[data-calendar-now-slot]');stops.push(mountCalendarNow(goalHost,{invoke,headerElement:running,headerLabel:'Сегодня',hideTaskCard:true,openInProgress:()=>root.querySelector('[data-today-title]')?.focus()}));
 stops.push(mountThemeControl(host,{getTheme:()=>doc.documentElement.dataset.theme,setTheme:value=>{doc.documentElement.dataset.theme=value;}}));placeThemeControlNextToToday(host,running);
 const tabs=mountDashboardWorkViews(root.querySelector('[data-calendar-task-widget]'));stops.push(tabs);tabs.select(view);
 let personal=null,today=null;
 const daily=mountCalendarDashboardTasks(root.querySelector('[data-calendar-today-tasks]'),{invoke,now:()=>now,openTask:()=>tell('Карточка native-задачи.'),executeAction:()=>false,notifyChange(){}});daily.setCurrentTask({key:'note:fixture-personal',state:'active'});stops.push(daily);
 today=mountCalendarTodayAction(root.querySelector('[data-calendar-next-action]'),{invoke,clock:()=>now,preferences:{includeRoutines:false},taskOptions:{invoke},compactRunning:true,onChooseTasks:()=>tabs.select('personal'),onCurrentTaskChange:task=>{personal?.setSelectedTask(task);daily.setCurrentTask({key:task?`${task.source_type}:${task.source_id}`:'',state:task?'active':''});},openTask:()=>tell('В приложении здесь открывается эта native-задача.'),executeTask:()=>{tell('Действия таймера не выполняются в QA-макете.');return false;},notifyChange(){}});stops.push(today);
 personal=mountCalendarInProgress(root.querySelector('[data-calendar-in-progress]'),{invoke,now:()=>now,title:'Работа сейчас',activeOnly:true,hideWhenEmpty:true,embedded:true,singleSelection:true,selectedTask:tasks[0],onSelectedTaskState:state=>today?.setFocusedTaskVisible('task:note:fixture-personal',state.visible),openTask:()=>tell('Карточка личной задачи.'),notifyChange(){}});stops.push(personal);
 const projection={tasks:[{taskKey:'fixture-ai',title:'Проверить синтетический проект',project:{id:'fixture-project',name:'Учебный проект'},tags:[{id:'review',name:'Проверка'}],needsUser:true,resultVersion:2,reviewState:'awaiting_review'},{taskKey:'fixture-ai-unknown',title:'Подготовить черновик документа',project:{id:'fixture-project',name:'Учебный проект'},tags:[],needsUser:null}],reports:[{taskKey:'fixture-ai',runId:'fixture-run',agent:'Тестовый исполнитель',model:'Модель из отчёта',status:'done',stage:'Проверка',receivedOrder:1,receivedAt:'2026-10-04T08:00:00Z',freshness:'stale'}]};
 if(scenario==='long-content')projection.tasks[0].tags=[{id:'fixture-long-tag',name:'Тег🙂漢字'.repeat(40)}];
 const read=scenario==='unavailable'?null:async()=>{if(scenario==='error')throw Error('Synthetic unavailable');if(scenario==='loading')return new Promise(()=>{});return scenario==='empty'?{tasks:[],reports:[]}:structuredClone(projection);};
 stops.push(mountDashboardAiWork(root.querySelector('[data-calendar-ai-work]'),{read,onOpenTask:()=>tell('В приложении здесь открывается связанная native-задача.'),onOpenTasks:()=>tell('В приложении здесь открывается существующий раздел «Задачи».')}));
 const dispose=()=>{for(const stop of stops.reverse())stop();host.replaceChildren();};dispose.calls=calls;return dispose;
}

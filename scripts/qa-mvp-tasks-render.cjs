/* Hosted source render only: synthetic IPC, no installed app or production data. */
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'), output=path.join(root,'.local/mvp-tasks-render'); fs.mkdirSync(output,{recursive:true});
const fixture=`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/src/styles.css"><link rel="stylesheet" href="/src/hanni/css/calendar-dashboard-v7.css"><link rel="stylesheet" href="/src/hanni/css/calendar-tasks.css"><link rel="stylesheet" href="/src/hanni/css/calendar-workspace.css"><link rel="stylesheet" href="/src/hanni/css/ui-actions.css">
<script src="/src/public/marked.min.js"></script><script src="/src/public/highlight.min.js"></script><script src="/src/public/vendor/purify.min.js"></script></head><body><div id="app-body"><div id="content-area"><div id="view-calendar" class="view active"><div id="calendar-content" class="tab-content"></div></div></div></div><script type="module">import {loadCalendarWorkspace} from '/src/hanni/js/calendar-workspace.js'; await loadCalendarWorkspace(document.getElementById('calendar-content')); window.fixtureReady=true;</script></body></html>`;
const records=()=>[
 {source_type:'note',source_id:'long',id:'long',title:'Очень длинная задача для проверки безопасного отображения текста',content:'Plain body: <script>must stay text</script>',date:null,status_extra:'task',status:'task',completed:false,archived:false,version:4,is_active:false,has_work:false,actual_seconds:0,sphere:'personal'},
 {source_type:'note',source_id:'paused',id:'paused',title:'Пауза',content:'paused body',date:new Date().toISOString().slice(0,10),status_extra:'task',status:'task',completed:false,archived:false,version:7,is_active:false,has_work:true,actual_seconds:90,sphere:'personal'},
 {source_type:'note',source_id:'running',id:'running',title:'Параллельная работа',content:'running body',date:new Date().toISOString().slice(0,10),status_extra:'task',status:'task',completed:false,archived:false,version:8,is_active:true,has_work:true,actual_seconds:120,sphere:'personal'},
 {source_type:'note',source_id:'done',id:'done',title:'Готово',content:'done body',date:new Date().toISOString().slice(0,10),status_extra:'done',status:'done',completed:true,archived:false,version:3,is_active:false,has_work:true,actual_seconds:120,sphere:'personal'},
 {source_type:'note',source_id:'archived',id:'archived',title:'В архиве',content:'archived body',date:null,status_extra:'task',status:'task',completed:false,archived:true,version:11,is_active:false,has_work:true,actual_seconds:120,sphere:'personal'}
];
function backend(){
 const state={rows:records(),calls:[],ui:{},archiveMode:false}; window.fixtureState=state;
 const invoke=async(command,args={})=>{state.calls.push({command,args:structuredClone(args)}); const row=id=>state.rows.find(r=>String(r.source_id)===String(id));
  if(command==='get_calendar_tasks') return state.rows.filter(r=>args.includeArchived||!r.archived).filter(r=>args.includeCompleted||(!r.completed&&r.status==='task')).map(structuredClone);
  if(command==='get_calendar_task'){const x=row(args.id);return x&&structuredClone(x);}
  if(command==='get_calendar_task_goals')return[];
  if(command==='get_calendar_records')return[];
  if(command==='get_ui_state')return state.ui[args.key]??null;
  if(command==='get_goals')return[];
  if(command==='get_calendar_task_blocks')return state.rows.filter(r=>String(r.source_id)===String(args.sourceIds?.[0])).flatMap(r=>r.has_work?[{source_type:'note',source_id:r.id,date:new Date().toISOString().slice(0,10),start_time:'10:00:00',end_time:'10:01:30',duration_seconds:r.actual_seconds,is_active:r.is_active}]:[]);
  if(command==='get_active_blocks')return state.rows.filter(r=>r.is_active).map(r=>({source_type:'note',source_id:r.id,date:r.date,start_time:'10:00:00',is_active:true,title:r.title,tags:'task-sphere:personal'}));
  if(command==='get_calendar_task_minutes')return 0;
  if(command==='toggle_note_archive'){const x=row(args.id);assert(x);assert.equal(args.expectedVersion,x.version);x.archived=!x.archived;x.version++;return x.archived;}
  if(command==='get_notes')return state.rows.map(structuredClone);
  if(command==='read_calendar_day')return {scope:'device_local',date:new Date().toISOString().slice(0,10),day:{date:new Date().toISOString().slice(0,10),closed:false,plan_ids:[],summaries:[]},active_blocks:[],candidates:[],history:[]};
  if(command==='get_recurring_items'||command==='get_schedules'||command==='get_timeline_blocks'||command==='get_task_pins')return[];
  if(command.startsWith('get_')||command.startsWith('mvp_sync_'))return null;
  throw Error('Unexpected fixture mutation: '+command);
 }; window.__TAURI__={core:{invoke},event:{listen:async()=>()=>{},emit:async()=>{}}};
}
const server=http.createServer((req,res)=>{const name=new URL(req.url,'http://fixture').pathname;if(name==='/'){res.setHeader('Content-Type','text/html');res.end(fixture);return;}const file=path.resolve(root,'.'+name);if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',({'.js':'text/javascript','.json':'application/json','.css':'text/css','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));});
async function shot(page,label,observations){await page.screenshot({path:path.join(output,label+'.png'),fullPage:true});observations.push({label,text:await page.locator('#calendar-content').innerText(),width:await page.evaluate(()=>innerWidth)});}
async function main(){assert.equal(process.platform,'linux');const chrome=process.env.MVP_TASKS_CHROME;assert.ok(chrome,'hosted Chrome path required');await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true,executablePath:chrome});const observations=[];
 try{for(const width of [1100,390])for(const theme of ['light','dark']){const page=await browser.newPage({viewport:{width,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.addInitScript(backend);await page.addInitScript(({theme})=>localStorage.setItem('hanni_theme',theme),{theme});await page.goto('http://127.0.0.1:'+server.address().port,{waitUntil:'networkidle'});await page.waitForFunction(()=>window.fixtureReady);await page.locator('[data-calendar-task-area]').waitFor();const dashboardText=await page.locator('[data-calendar-task-area]').innerText();assert.match(dashboardText,/Параллельная работа|Пауза/);await shot(page,`${width}-${theme}-dashboard`,observations);await page.locator('.uni-tab[data-pane="tasks"]').click();await page.locator('[data-tasks-filter]').first().waitFor();
   const controls=page.locator('[data-tasks-filter]');assert.ok(await controls.count()>=4);assert.equal(await page.locator('[data-tasks-search]').count(),1);assert.equal(await page.locator('[data-tasks-filter="active"]').getAttribute('aria-pressed'),'true');await page.locator('[data-tasks-filter="archived"]').waitFor();
   await shot(page,`${width}-${theme}-captureTasks-active`,observations);await page.locator('[data-tasks-filter="all"]').click();await page.locator('[data-task-control="open"]').first().waitFor();await shot(page,`${width}-${theme}-captureTasks-all`,observations);
   await page.locator('[data-tasks-filter="completed"]').click();await page.locator('[data-tasks-filter="archived"]').click();
   const archive=page.locator('.ct-restore').first();if(await archive.count()){await archive.click();await page.locator('dialog[open] [type="submit"]').click();await page.waitForFunction(()=>window.fixtureState.rows.find(r=>r.id==='archived').archived===false);}
   await page.locator('[data-tasks-filter="archived"]').click();await shot(page,`${width}-${theme}-Archive`,observations);
   await page.locator('[data-tasks-filter="active"]').click();await page.locator('[data-tasks-search]').fill('Очень длинная');await page.locator('[data-task-control="open"]').first().click();await page.locator('.task-details-description').waitFor({state:'visible'}).catch(()=>{});if(await page.locator('.task-details-description').count()){assert.doesNotMatch(await page.locator('.task-details-description-content').innerText(),/<script>/);await shot(page,`${width}-${theme}-details`,observations);} 
   assert.deepEqual(errors,[]);const calls=await page.evaluate(()=>window.fixtureState.calls);assert.equal(calls.some(c=>!c.command.startsWith('get_')&&!['toggle_note_archive'].includes(c.command)&&!c.command.startsWith('mvp_sync_')),false);assert.equal(calls.filter(c=>c.command==='toggle_note_archive').length<=1,true);await page.close();}}
 finally{fs.writeFileSync(path.join(output,'observations.json'),JSON.stringify(observations,null,2));await browser.close();server.close();}console.log(JSON.stringify({sourceOnly:true,observations:observations.length,installedAcceptance:false}));}
main().catch(e=>{fs.writeFileSync(path.join(output,'failure.txt'),e.stack);server.close();console.error(e);process.exitCode=1;});

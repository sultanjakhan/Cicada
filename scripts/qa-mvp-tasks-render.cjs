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
function backend({rows,reviewUnavailable=false}){
 const day = new Date().toLocaleDateString('sv-SE');
 rows.forEach(row=>{if(row.date)row.date=day;});
 const state={rows:rows.map(row=>structuredClone(row)),calls:[],ui:{},archiveMode:false}; window.fixtureState=state;
 const blocks=state.rows.filter(row=>row.has_work).map((row,index)=>({id:index+1,source_type:'note',source_id:row.id,title:row.title,date:day,completion_date:day,start_time:new Date(Date.now()-120000).toTimeString().slice(0,8),end_time:row.is_active?null:new Date(Date.now()-30000).toTimeString().slice(0,8),duration_seconds:row.is_active?0:90,is_active:row.is_active}));
 const invoke=async(command,args={})=>{state.calls.push({command,args:structuredClone(args)}); const row=id=>state.rows.find(r=>String(r.source_id)===String(id));
  if(command==='get_calendar_tasks') return state.rows.filter(r=>args.includeArchived||!r.archived).filter(r=>args.includeCompleted||(!r.completed&&r.status==='task')).map(row=>structuredClone(row));
  if(command==='get_calendar_task'||command==='get_note'){const x=row(args.id);return x&&structuredClone(x);}
  if(command==='get_calendar_task_goals')return[];
  if(command==='get_calendar_records')return state.rows.filter(row=>!row.archived&&!row.completed).map(row=>structuredClone(row));
  if(command==='get_ui_state')return state.ui[args.key]??null;
  if(command==='set_ui_state'&&args.key==='calendar_now_v1'){
    if(args.expectedValue!==undefined&&(args.expectedValue??'')!==(state.ui[args.key]??''))throw Error('Synthetic UI state changed');
    state.ui[args.key]=args.value;return null;
  }
  if(command==='get_goals')return[];
  if(command==='get_calendar_task_blocks')return structuredClone(blocks.filter(block=>(args.sourceIds||[]).map(String).includes(block.source_id)));
  if(command==='get_active_blocks')return structuredClone(blocks.filter(block=>block.is_active));
  if(command==='get_timeline_blocks')return structuredClone(blocks.filter(block=>block.date===args.date));
  if(command==='get_calendar_task_seconds')return row(args.sourceId)?.actual_seconds||0;
  if(command==='shared_task_command'&&args.input?.command==='get')return reviewUnavailable?{isError:true,status:503,code:'synthetic_review_unavailable'}:{isError:true,status:404,code:'shared_task_not_found'};
  if(command==='get_calendar_task_minutes')return 0;
  if(command==='toggle_note_archive'){const x=row(args.id);if(!x)throw Error('missing fixture row');if(args.expectedVersion!==x.version)throw Error('stale fixture version');x.archived=!x.archived;x.version++;return x.archived;}
  if(command==='get_notes')return state.rows.map(row=>structuredClone(row));
  if(command==='read_calendar_day')return {scope:'device_local',date:day,day:{date:day,closed:false,plan_ids:[],summaries:[]},active_blocks:[],candidates:[],history:[]};
  if(command==='get_recurring_items'||command==='get_schedules'||command==='get_timeline_blocks'||command==='get_task_pins')return[];
  if(command.startsWith('get_')||command.startsWith('mvp_sync_'))return null;
  throw Error('Unexpected fixture mutation: '+command);
 }; window.__TAURI__={core:{invoke},event:{listen:async()=>()=>{},emit:async()=>{}}};
}
const server=http.createServer((req,res)=>{const name=new URL(req.url,'http://fixture').pathname;if(name==='/'){res.setHeader('Content-Type','text/html');res.end(fixture);return;}const file=path.resolve(root,'.'+name);if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',({'.js':'text/javascript','.json':'application/json','.css':'text/css','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));});
async function shot(page,label,observations){await page.screenshot({path:path.join(output,label+'.png'),fullPage:true});observations.push({label,text:await page.locator('#calendar-content').innerText(),width:await page.evaluate(()=>innerWidth)});}
async function visibleCreate(page){
 const create=page.locator('[data-calendar-create]');
 assert.equal(await create.isVisible(),true);
 const style=await create.evaluate(node=>{const box=node.getBoundingClientRect(),css=getComputedStyle(node);return {width:box.width,height:box.height,color:css.color,background:css.backgroundColor};});
 assert.ok(style.width>=70&&style.height>=40,'Create has a readable hit area');
 assert.notEqual(style.background,'rgba(0, 0, 0, 0)','primary background survives action reset');
 assert.notEqual(style.color,style.background,'Create label contrasts with its background');
 await create.click();await page.getByRole('menu',{name:'Что создать'}).waitFor();await page.keyboard.press('Escape');
}
async function main(){assert.equal(process.platform,'linux');const chrome=process.env.MVP_TASKS_CHROME;assert.ok(chrome,'hosted Chrome path required');await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true,executablePath:chrome});const observations=[];
 try{for(const width of [1100,390])for(const theme of ['light','dark'])for(const scenario of ['filled','empty','review-unavailable']){
   const page=await browser.newPage({viewport:{width,height:900},timezoneId:'Asia/Almaty'}),errors=[];
   page.on('pageerror',error=>errors.push(error.message));
   const rows=scenario==='empty'?[]:records();
   const label=`${width}-${theme}-${scenario}`;
   const rowIds=async expected=>page.waitForFunction(ids=>JSON.stringify([...document.querySelectorAll('[data-workspace-task-list] .ct-row')].map(node=>node.dataset.contextRecord).sort())===JSON.stringify(ids.map(id=>'note:'+id).sort()),expected);
   try{
     await page.addInitScript(backend,{rows,reviewUnavailable:scenario==='review-unavailable'});
     await page.addInitScript(({theme})=>localStorage.setItem('hanni_theme',theme),{theme});
     await page.goto('http://127.0.0.1:'+server.address().port,{waitUntil:'networkidle'});
     await page.waitForFunction(()=>window.fixtureReady);
     await visibleCreate(page);
     await page.locator('[data-calendar-task-area]').waitFor();
     await page.locator('.calendar-now__goal h2').waitFor();
     assert.doesNotMatch(await page.locator('#calendar-content').innerText(),/Не удалось обновить текущую задачу|Загружаем цель/);
     if(scenario!=='empty'){
       await page.locator('[data-calendar-task-area] .cip-row[data-context-record="note:running"]').waitFor();
       await page.locator('[data-calendar-task-area] .cip-row[data-context-record="note:paused"]').waitFor();
       if(scenario==='filled')for(const id of ['running','paused']){
         await page.locator('[data-today-choose]').click();
         await page.locator('[data-today-scope="tasks"]').click();
         await page.locator(`[data-today-task-choices] [data-overview-task="note:${id}"]`).click();
         await page.locator(`[data-calendar-task-area] .cip-row[data-context-record="note:${id}"][aria-current="true"] [data-cip-selected]`).waitFor();
         assert.equal(await page.locator('[data-calendar-task-area] [data-cip-selected]').count(),1);
         assert.equal(await page.locator('[data-calendar-task-area] .cip-row').count(),2);
       }
     }
     await shot(page,label+'-dashboard',observations);
     await page.locator('.uni-tab[data-pane="tasks"]').click();
     await page.locator('[data-task-view-id="@archive"]').waitFor();
     assert.equal(await page.locator('[data-tasks-search]').count(),1);
     assert.equal(await page.locator('[data-calendar-create]').count(),1);
     assert.equal(await page.locator('.ct-view-management[open]').count(),0);
     assert.equal(await page.locator('.ct-filter-details[open]').count(),0);
     await rowIds(scenario==='empty'?[]:['long','paused','running']);
     if(scenario==='review-unavailable'){
       await page.locator('[data-tasks-search]').fill('Очень длинная');await rowIds(['long']);
       await page.locator('[data-task-control="review-retry"]').waitFor();
       await page.locator('[data-task-control="open"]').click();
       await page.locator('.task-details-description').waitFor();
       await shot(page,label+'-clickable-title',observations);
       assert.deepEqual(errors,[]);continue;
     }
     if(scenario==='empty'){
       await page.locator('.ct-empty').waitFor();
       assert.match(await page.locator('.ct-empty').innerText(),/нет|создай/i);
       await shot(page,label+'-tasks',observations);
     }else{
       await shot(page,label+'-active',observations);
       await page.locator('[data-task-view-id="all"]').click();await rowIds(['long','paused','running','done']);
       await shot(page,label+'-all',observations);
       await page.locator('[data-task-view-id="@completed"]').click();await rowIds(['done']);
       await shot(page,label+'-completed',observations);
       await page.locator('[data-task-view-id="@archive"]').click();await rowIds(['archived']);
       await shot(page,label+'-archive',observations);
       await page.locator('.ct-restore').click();await page.locator('dialog[open] [type="submit"]').click();
       await page.waitForFunction(()=>!window.fixtureState.rows.find(row=>row.id==='archived').archived);
       await rowIds([]);await shot(page,label+'-archive-after-restore',observations);
       const restored=await page.evaluate(()=>window.fixtureState.rows.find(row=>row.id==='archived'));
       assert.equal(restored.version,12);assert.equal(restored.content,'archived body');assert.equal(restored.completed,false);
       assert.deepEqual(await page.evaluate(()=>window.fixtureState.calls.filter(call=>call.command==='toggle_note_archive').map(call=>call.args)),[{id:'archived',expectedVersion:11}]);
       await page.locator('[data-task-view-id="active"]').click();await rowIds(['long','paused','running','archived']);
       await page.locator('[data-tasks-search]').fill('Очень длинная');await rowIds(['long']);
       await page.locator('[data-task-control="open"]').click();await page.locator('.task-details-description').waitFor();
       await page.locator('.task-details-description summary').click();
       assert.equal(await page.locator('.task-details-description-content').innerText(),'Plain body: <script>must stay text</script>');
       assert.equal(await page.locator('.task-details-description-content script').count(),0);
       await shot(page,label+'-details',observations);
     }
     assert.equal(await page.locator('#calendar-content').evaluate(node=>node.scrollWidth<=node.clientWidth+1),true);
     const calls=await page.evaluate(()=>window.fixtureState.calls);
     assert.deepEqual(calls.filter(call=>!call.command.startsWith('get_')&&!call.command.startsWith('mvp_sync_')&&!['toggle_note_archive','read_calendar_day'].includes(call.command)&&!(call.command==='shared_task_command'&&call.args.input?.command==='get')&&!(call.command==='set_ui_state'&&call.args.key==='calendar_now_v1')),[]);
   }finally{
     if(errors.length)fs.writeFileSync(path.join(output,label+'-pageerrors.json'),JSON.stringify(errors));
     assert.deepEqual(errors,[]);await page.close();
   }
 }}
 finally{fs.writeFileSync(path.join(output,'observations.json'),JSON.stringify(observations,null,2));await browser.close();server.close();}console.log(JSON.stringify({sourceOnly:true,observations:observations.length,installedAcceptance:false}));}
main().catch(e=>{fs.writeFileSync(path.join(output,'failure.txt'),e.stack);server.close();console.error(e);process.exitCode=1;});

/* Hosted cloud UI fixture: actual workspace/modules/CSS, fictional IPC only. */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const project = path.resolve(__dirname, '..');
const root = project;
const output = path.join(project,'.local/focus-adapter-render');
fs.mkdirSync(output,{recursive:true});
const fixture = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/src/styles.css"><link rel="stylesheet" href="/src/hanni/css/calendar-dashboard-v7.css"><link rel="stylesheet" href="/src/hanni/css/sync-conflicts.css"><link rel="stylesheet" href="/src/hanni/css/ui-actions.css">
<script src="/src/public/marked.min.js"></script><script src="/src/public/highlight.min.js"></script><script src="/src/public/vendor/purify.min.js"></script></head>
<body><div id="app-body"><div id="content-area"><div id="view-calendar" class="view active"><div id="calendar-content" class="tab-content"></div></div></div></div>
<script type="module">import {loadCalendarWorkspace} from '/src/hanni/js/calendar-workspace.js'; await loadCalendarWorkspace(document.getElementById('calendar-content')); window.fixtureReady=true;</script></body></html>`;
const server = http.createServer((request,response)=>{
  const name=decodeURIComponent(new URL(request.url,'http://fixture').pathname);
  if(name==='/'){response.setHeader('Content-Type','text/html');response.end(fixture);return;}
  const file=path.resolve(root,'.'+name);
  if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){response.writeHead(404);response.end();return;}
  response.setHeader('Content-Type',({'.js':'text/javascript','.json':'application/json','.css':'text/css','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream');response.end(fs.readFileSync(file));
});
function syntheticBackend({theme}) {
  localStorage.setItem('hanni_theme',theme);
  const day=new Date().toISOString().slice(0,10);
  const goals=[{id:'fixture-root',title:'Изучить анализ данных',goal_kind:'goal',status:'active',target_value:1,parent_goal_id:null,description:'Применить знания в учебном проекте',criteria:'Закончить проект и описать результат'},
    {id:'fixture-child',title:'Освоить SQL',goal_kind:'goal',status:'active',target_value:1,parent_goal_id:'fixture-root',description:'Работа с учебными данными',criteria:'Подготовить запросы'}];
  const tasks=[{source_type:'note',source_id:'fixture-task-1',title:'Разобрать учебную задачу',date:day,status_extra:'task',tags:'task-sphere:personal',completed:false},
    {source_type:'note',source_id:'fixture-task-2',title:'Подготовить пример запроса',date:null,status_extra:'task',tags:'task-sphere:personal',completed:false}];
  const ui={calendar_now_v1:JSON.stringify({version:1,goalId:'fixture-root'}),calendar_development_v1:JSON.stringify({version:1,goals:{'fixture-root':{skills:[],stages:[{id:'fixture-stage-1',title:'Понимание',skillIds:[]},{id:'fixture-stage-2',title:'Практика',skillIds:[]}],activeStageId:'fixture-stage-1'}}})};
  window.fixtureCalls=[];window.fixtureUI=ui;
  const invoke=async(command,args={})=>{
    window.fixtureCalls.push({command,args:structuredClone(args)});
    if(command==='get_ui_state'){if(window.fixtureFocusOffline && args.key==='cicada_focus_adapter_local_v1')throw Error('synthetic offline');return ui[args.key]??null;}
    if(command==='set_ui_state'){if(args.key!=='cicada_focus_adapter_local_v1')throw Error('Unexpected write');if((ui[args.key]??'')!==args.expectedValue)throw Error('stale');ui[args.key]=args.value;return null;}
    if(command==='get_goals')return structuredClone(goals);
    if(command==='get_calendar_tasks')return structuredClone(tasks);
    if(command==='get_calendar_task')return structuredClone(tasks.find(t=>t.source_id===args.id)||tasks[0]);
    if(command==='get_calendar_task_goals')return [{source_type:'note',source_id:'fixture-task-1',goal_id:'fixture-root'}];
    if(command==='get_active_blocks'||command==='get_calendar_records'||command==='get_timeline_blocks'||command==='get_task_pins'||command==='get_recurring_items')return [];
    if(command==='get_calendar_task_minutes')return 0;
    if(command==='read_calendar_day')return {scope:'device_local',date:day,day:{date:day,closed:false,plan_ids:[],summaries:[]},active_blocks:[],candidates:[],history:[]};
    if(command==='shared_task_command')return {isError:true,status:404,code:'task_not_found'};
    if(command==='get_active_block')return null;
    if(command.startsWith('get_'))return null;
    if(command.startsWith('mvp_sync_'))return null;
    throw new Error('Unsupported fixture IPC: '+command);
  };
  window.__TAURI__={core:{invoke},event:{listen:async()=>()=>{},emit:async()=>{}}};
}
async function main(){
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,executablePath:process.env.FOCUS_ADAPTER_CHROME});
  const evidence=[];
  try {
    for(const [width,theme] of [[1100,'light'],[390,'dark']]) {
      const page=await browser.newPage({viewport:{width,height:820}}), errors=[];
      page.on('pageerror',error=>errors.push(error.message));
      await page.addInitScript(syntheticBackend,{theme});
      await page.goto('http://127.0.0.1:'+server.address().port,{waitUntil:'networkidle'});
      await page.waitForFunction(()=>window.fixtureReady);
      const initial=await page.evaluate(()=>structuredClone(window.fixtureUI));
      const open=async()=>{
        await page.evaluate(async()=>{const {showCalendarSettings}=await import('/src/hanni/js/calendar-settings.js');showCalendarSettings(document.querySelector('.uni-tab'),{section:'connections'});});
        await page.locator('[data-focus-adapter] > summary').click();
        await page.locator('[data-focus-action="save"]:enabled').waitFor();
      };
      await open();
      const scope=page.locator('[data-focus-adapter]'), status=scope.locator('[role="status"]');
      const action=name=>scope.locator('[data-focus-action="'+name+'"]');
      const field=name=>scope.locator('[data-focus-field="'+name+'"]');
      const capture=async(name,anchor,targets)=>{
        await anchor.evaluate(el=>el.scrollIntoView({block:'end',inline:'nearest'}));
        await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        const visible=[];
        for(const target of targets){
          assert.equal(await target.isVisible(),true,name+' target displayed');
          const bounds=await target.evaluate(el=>{
            const box=el.getBoundingClientRect();let top=0,bottom=innerHeight,left=0,right=innerWidth;
            for(let parent=el.parentElement;parent;parent=parent.parentElement){
              const style=getComputedStyle(parent),rect=parent.getBoundingClientRect();
              if(/auto|scroll|hidden|clip/.test(style.overflowY)){top=Math.max(top,rect.top);bottom=Math.min(bottom,rect.bottom);}
              if(/auto|scroll|hidden|clip/.test(style.overflowX)){left=Math.max(left,rect.left);right=Math.min(right,rect.right);}
            }
            return {top:box.top,bottom:box.bottom,left:box.left,right:box.right,clip:{top,bottom,left,right}};
          });
          assert.ok(bounds.top>=bounds.clip.top-1&&bounds.bottom<=bounds.clip.bottom+1&&bounds.left>=bounds.clip.left-1&&bounds.right<=bounds.clip.right+1,name+' target inside actual scroll viewport: '+JSON.stringify(bounds));
          visible.push(bounds);
        }
        await page.screenshot({path:path.join(output,width+'-'+theme+'-'+name+'.png'),fullPage:true});
        evidence.push({width,theme,capture:name,visible});
      };
      await field('sites').fill('example.com video.example.com');
      await field('exceptions').fill('chat.example.com mail.example.com');
      await field('times').fill('0900-1200,1300-1700');
      for(const day of [1,2,3,4,5])await scope.locator('[data-focus-day="'+day+'"]').check();
      await action('save').focus();await page.keyboard.press('Enter');
      await status.filter({hasText:'Сохранено и перечитано'}).waitFor();
      await capture('form-top',field('times'),['platform','sites','exceptions','times'].map(name=>field(name).locator('..')));
      const saved=await page.evaluate(()=>window.fixtureUI.cicada_focus_adapter_local_v1);
      await action('export').focus();await page.keyboard.press('Space');
      await scope.locator('pre:visible').waitFor();
      assert.match(await scope.locator('pre').innerText(),/НЕ файл Import Options/);
      const prefix=width+'-'+theme;
      await action('export').focus();
      const geometry=await scope.evaluate(root=>({overflow:root.scrollWidth>root.clientWidth+1,inputs:[...root.querySelectorAll('input[type="text"],select')].map(el=>({width:el.getBoundingClientRect().width,right:el.getBoundingClientRect().right})),focus:{tag:document.activeElement.tagName,outline:getComputedStyle(document.activeElement).outlineStyle},text:root.innerText}));
      assert.equal(geometry.overflow,false);assert.notEqual(geometry.focus.outline,'none');
      await scope.locator('pre').evaluate(el=>el.scrollIntoView({block:'start',inline:'nearest'}));
      await page.screenshot({path:path.join(output,prefix+'-instruction-start.png'),fullPage:true});
      await capture('instruction-download-bottom',scope.locator('a'),[scope.locator('a')]);
      evidence.push({width,theme,state:'manual-export',geometry});
      await page.keyboard.press('Escape');await page.locator('dialog[open]').waitFor({state:'detached'});
      await open();assert.equal(await field('times').inputValue(),'0900-1200,1300-1700');assert.equal(await field('exceptions').inputValue(),'chat.example.com mail.example.com');
      for(const day of [1,2,3,4,5])assert.equal(await scope.locator('[data-focus-day="'+day+'"]').isChecked(),true);
      await field('platform').selectOption('unsupported');await action('save').click();await status.filter({hasText:'Сохранено и перечитано'}).waitFor();
      assert.equal(await action('export').isDisabled(),true);
      evidence.push({width,theme,state:'unsupported',text:await status.innerText(),saved});
      const after=await page.evaluate(()=>structuredClone(window.fixtureUI));delete after.cicada_focus_adapter_local_v1;assert.deepEqual(after,initial,'selected goal and unrelated configuration unchanged');
      await page.keyboard.press('Escape');await page.locator('dialog[open]').waitFor({state:'detached'});
      await page.evaluate(()=>{window.fixtureFocusOffline=true;});
      await page.evaluate(async()=>{const {showCalendarSettings}=await import('/src/hanni/js/calendar-settings.js');showCalendarSettings(document.querySelector('.uni-tab'),{section:'connections'});});
      await scope.locator('summary').click();await status.filter({hasText:'Загрузка не удалась'}).waitFor();assert.equal(await action('save').isDisabled(),true);
      await capture('unavailable-controls',status,[action('save'),action('reload'),status]);
      await page.evaluate(()=>{window.fixtureFocusOffline=false;});await action('reload').click();await page.locator('[data-focus-action="save"]:enabled').waitFor();
      assert.equal(await field('platform').inputValue(),'unsupported');
      const calls=await page.evaluate(()=>window.fixtureCalls);
      assert.equal(calls.filter(c=>c.command==='set_ui_state').every(c=>c.args.key==='cicada_focus_adapter_local_v1'),true);
      assert.equal(calls.some(c=>/^(start_|pause_|resume_|stop_|complete_|apply_|install_)/.test(c.command)),false);
      evidence.push({width,theme,state:'retry',calls,errors});assert.deepEqual(errors,[]);
      await page.close();
    }
  } finally {fs.writeFileSync(path.join(output,'observations.json'),JSON.stringify(evidence,null,2));await browser.close();server.close();}
}
main().catch(error=>{console.error(error);server.close();process.exitCode=1;});

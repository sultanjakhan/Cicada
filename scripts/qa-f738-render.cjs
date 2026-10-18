/* Hosted cloud UI fixture: actual workspace/modules/CSS, fictional IPC only. */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const project = path.resolve(__dirname, '..');
const root = project;
const output = path.join(project,'.local/f738-render');
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
// Fictional records only. Every mutation fails: navigation and rejected Resume
// preserve state. These checks do not substitute for native execution acceptance.
function syntheticBackend({theme, scenario}) {
  localStorage.setItem('hanni_theme',theme);
  const day=new Date().toISOString().slice(0,10);
  const future=new Date(Date.now()+86400000).toISOString().slice(0,10);
  const task={source_type:'note',source_id:'fixture-task',title:'Разобрать учебную задачу',date:scenario==='future'?future:day,status_extra:'task',completed:false,
    waiting:scenario==='waiting',has_work:scenario==='paused',actual_seconds:scenario==='paused'?90:0,is_active:false};
  const tasks=['empty','routine'].includes(scenario)?[]:[task];
  const goal={id:'fixture-goal',title:'Учебный проект',goal_kind:'goal',status:'active',target_value:1,parent_goal_id:null,description:'',criteria:''};
  const routine={id:'fixture-required',title:'Обязательная учебная рутина',kind:'action',mode:'graph',active:true,required:true,createdOn:day,startsOn:'',endsOn:'',time:'',weekdays:[0,1,2,3,4,5,6],steps:[{title:'Учебный шаг',dependsOn:[],trackingMode:'check',optional:false}]};
  const ui={calendar_now_v1:JSON.stringify({version:1,goalId:goal.id}),calendar_recurring_v1:JSON.stringify({version:1,plans:scenario==='routine'?[routine]:[],days:{}})};
  window.fixtureCalls=[];
  window.fixtureInitialUI=JSON.stringify(ui);
  window.fixtureUI=ui;
  let compact=false;
  window.fixtureSetCompact=async value=>{
    await invoke('set_compact_window',{compact:value});
    document.documentElement.classList.toggle('calendar-compact-mode',compact);
  };
  const invoke=async(command,args={})=>{
    window.fixtureCalls.push({command,args:structuredClone(args)});
    if(command==='get_ui_state')return ui[args.key]??null;
    if(command==='get_compact_window_state')return {supported:true,compact};
    if(command==='set_compact_window'){compact=args.compact;return {supported:true,compact};}
    if(command==='get_goals')return [structuredClone(goal)];
    if(command==='get_calendar_tasks')return structuredClone(tasks);
    if(command==='get_calendar_task')return structuredClone(task);
    if(command==='get_calendar_task_goals')return tasks.map(t=>({source_type:t.source_type,source_id:t.source_id,goal_id:goal.id}));
    if(['get_active_blocks','get_calendar_records','get_timeline_blocks','get_task_pins','get_recurring_items','get_schedules'].includes(command))return [];
    if(command==='get_calendar_task_minutes')return scenario==='paused'?1.5:0;
    if(command==='read_calendar_day')return {scope:'device_local',date:day,day:{date:day,closed:false,plan_ids:[],summaries:[]},active_blocks:[],candidates:[],history:[]};
    if(command==='shared_task_command')return {isError:true,status:404,code:'task_not_found'};
    if(command.startsWith('get_')||command.startsWith('mvp_sync_'))return null;
    throw Error('Unexpected fixture mutation: '+command);
  };
  window.__TAURI__={core:{invoke},event:{listen:async()=>()=>{},emit:async()=>{}}};
}
const observations=[];
async function snapshot(page,label) {
  await page.screenshot({path:path.join(output,label+'.png'),fullPage:true});
  observations.push({label,text:await page.locator('#calendar-content').innerText(),focus:await page.evaluate(()=>{
    const n=document.activeElement,r=n.getBoundingClientRect(),s=getComputedStyle(n);
    return {tag:n.tagName,text:n.textContent,selectorData:{...n.dataset},focusVisible:n.matches(':focus-visible'),outline:s.outlineStyle,box:{x:r.x,y:r.y,width:r.width,height:r.height}};
  })});
  fs.writeFileSync(path.join(output,'observations.json'),JSON.stringify(observations,null,2));
}
async function openChoices(page) {
  await page.locator('[data-today-choose]').click();
  await page.locator('[data-today-scope="tasks"]').click();
  await page.locator('[data-today-task-choices] [data-overview-toggle][aria-pressed="true"]').waitFor();
}
async function main() {
  console.log(JSON.stringify({utc:new Date().toISOString(),cwd:process.cwd(),platform:process.platform,task:'f738163f-9ae9-42fe-8671-2237a7576346',model:null,provider:null,usage:null}));
  assert.equal(process.platform,'linux','hosted Linux only');
  assert.ok(process.env.F738_CHROME,'use the hosted runner Chrome; no browser download');
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,executablePath:process.env.F738_CHROME});
  try {
    for(const width of [1100,390])for(const theme of ['light','dark'])for(const scenario of ['future','empty','today','waiting','routine','paused']) {
      const page=await browser.newPage({viewport:{width,height:800},timezoneId:'UTC'}), errors=[];
      page.on('pageerror',error=>errors.push(error.message));
      await page.addInitScript(syntheticBackend,{theme,scenario});
      const label=`${width}-${theme}-${scenario}`;
      try {
        await page.goto('http://127.0.0.1:'+server.address().port,{waitUntil:'networkidle'});
        await page.waitForFunction(()=>window.fixtureReady);
        await page.locator('[data-today-choose]').waitFor();
        await page.waitForFunction(()=>!document.querySelector('[data-calendar-next-action]').textContent.includes('Загружаем'));
        await page.locator('[data-start-day]:enabled').waitFor();
        await snapshot(page,label+'-home');
        if(['future','empty','today'].includes(scenario)) {
          await openChoices(page);
          const today=page.locator('[data-today-task-choices] [data-overview-today-filter]');
          await today.click();
          const action=page.locator('[data-today-task-choices] [data-overview-show-all]');
          if(scenario==='today') {
            assert.equal(await action.count(),0,'nonempty Today has no duplicate action');
            await page.locator('[data-overview-today] [data-overview-task="note:fixture-task"]').waitFor();
            await snapshot(page,label+'-daily-list');
          } else {
            for(const key of ['Enter','Space']) {
              await page.keyboard.press('Tab'); await action.focus();
              await snapshot(page,label+'-focused-'+key);
              assert.equal(await action.evaluate(n=>n.matches(':focus-visible')),true);
              assert.notEqual(await action.evaluate(n=>getComputedStyle(n).outlineStyle),'none');
              await page.keyboard.press(key);
              await page.locator('[data-today-task-choices] [data-overview-all]:visible').waitFor();
              const target=scenario==='future'?'[data-overview-task="note:fixture-task"]':'[data-overview-toggle]';
              assert.equal(await page.locator('[data-today-task-choices] '+target).evaluate(n=>document.activeElement===n),true,'All focus destination');
              await snapshot(page,label+'-all-'+key);
              await today.click();
            }
          }
        } else if(scenario==='waiting') {
          await page.locator('[data-next-action-context]').filter({hasText:'Жду ответа'}).waitFor();
          await page.locator('[data-next-action-action="review"]').waitFor();
          assert.equal(await page.locator('[data-next-action-action="start"]:visible').count(),0,'waiting never offers an implicit start');
        } else if(scenario==='routine') {
          await page.locator('[data-next-action-key^="routine:fixture-required:"]').waitFor();
          await page.locator('[data-today-choose]').click();
          await page.locator('[data-routine-choice="fixture-required"]').waitFor();
          assert.match(await page.locator('[data-routine-choice="fixture-required"]').innerText(),/Начать/);
          await snapshot(page,label+'-required-routine-choice');
        } else {
          const resume=page.locator('[data-cip-control="toggle"][aria-label*="Продолжить"]:visible').first();
          await resume.waitFor();
          assert.equal(await resume.locator('.cip-resume-label').innerText(),'Продолжить');
          for(const key of ['Enter','Space']) {
            await page.keyboard.press('Tab'); await resume.focus();
            assert.equal(await resume.evaluate(n=>n.matches(':focus-visible')),true);
            assert.notEqual(await resume.evaluate(n=>getComputedStyle(n).outlineStyle),'none');
            assert.equal(await resume.evaluate(n=>{const b=n.getBoundingClientRect(),t=n.querySelector('.cip-resume-label').getBoundingClientRect();return b.width>40&&t.left>=b.left&&t.right<=b.right&&b.right<=innerWidth;}),true,'Resume label fits its dedicated button and viewport');
            await snapshot(page,label+'-resume-focused-'+key);
            const before=await page.evaluate(()=>window.fixtureCalls.filter(c=>c.command==='start_task_block').length);
            await page.keyboard.press(key);
            await page.waitForFunction(count=>window.fixtureCalls.filter(c=>c.command==='start_task_block').length===count+1,before);
            await page.waitForFunction(()=>[...document.querySelectorAll('.cip-message')].some(n=>n.textContent.includes('Unexpected fixture mutation: start_task_block')));
            await page.waitForFunction(()=>document.activeElement.matches('.cip-message[role="alert"]')&&document.activeElement.textContent.includes('Unexpected fixture mutation: start_task_block'));
            assert.equal(await resume.isEnabled(),true,'rejected Resume remains available for the same task');
          }
          await snapshot(page,label+'-continue');
          // Apply the actual compact CSS ancestry with the fixture's explicit
          // native window acknowledgement; no production window is controlled.
          await page.evaluate(()=>window.fixtureSetCompact(true));
          await page.keyboard.press('Tab'); await resume.focus();
          assert.equal(await resume.evaluate(n=>n.matches(':focus-visible')),true);
          assert.equal(await resume.evaluate(n=>{const b=n.getBoundingClientRect(),t=n.querySelector('.cip-resume-label').getBoundingClientRect();return t.right<=b.right&&b.right<=innerWidth;}),true,'compact Resume label fits');
          await snapshot(page,label+'-compact');
          await page.evaluate(()=>window.fixtureSetCompact(false));
        }
        assert.deepEqual(errors,[],'browser errors');
        const calls=await page.evaluate(()=>window.fixtureCalls);
        const allowed=['read_calendar_day','shared_task_command',...(scenario==='paused'?['start_task_block','set_compact_window']:[])];
        assert.equal(calls.some(c=>!c.command.startsWith('get_')&&!allowed.includes(c.command)&&!c.command.startsWith('mvp_sync_')),false,'no unexpected mutation attempts');
        if(scenario==='paused') {
          const starts=calls.filter(c=>c.command==='start_task_block');
          assert.equal(starts.length,2,'one rejected synthetic Resume request per keyboard activation');
          assert.equal(starts.every(c=>c.args.sourceType==='note'&&c.args.sourceId==='fixture-task'),true,'Resume retains exact task identity');
        }
        assert.equal(await page.evaluate(()=>JSON.stringify(window.fixtureUI)===window.fixtureInitialUI),true,'selected goal and routine definitions preserved');
        assert.equal(await page.locator('#calendar-content').evaluate(n=>n.scrollWidth>n.clientWidth+1),false,'horizontal overflow');
        observations.push({label,checks:'production workspace navigation only; no mutation; original-scope affordances are representative, not installed acceptance',errors,calls});
      } catch(error) {
        await snapshot(page,label+'-failure').catch(()=>{});
        observations.push({label,error:error.stack});throw error;
      } finally {
        fs.writeFileSync(path.join(output,'observations.json'),JSON.stringify(observations,null,2));
        await page.close();
      }
    }
  } finally { await browser.close();server.close(); }
}
main().catch(error=>{fs.writeFileSync(path.join(output,'failure.txt'),error.stack);server.close();console.error(error);process.exitCode=1;});

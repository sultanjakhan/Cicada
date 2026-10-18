/* Hosted cloud UI fixture: actual workspace/modules/CSS, fictional IPC only. */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const root = path.resolve(__dirname, '..');
const output = path.join(root,'.local/goals85-render');
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
    if(command==='get_ui_state')return ui[args.key]??null;
    if(command==='set_ui_state'){ui[args.key]=args.value;return null;}
    if(command==='get_goals')return structuredClone(goals);
    if(command==='get_calendar_tasks')return structuredClone(tasks);
    if(command==='get_calendar_task')return structuredClone(tasks.find(t=>t.source_id===args.id)||tasks[0]);
    if(command==='get_calendar_task_goals')return [{source_type:'note',source_id:'fixture-task-1',goal_id:'fixture-root'}];
    if(command==='get_active_blocks'||command==='get_calendar_records'||command==='get_calendar_task_minutes'||command==='get_recurring_items')return [];
    if(command==='get_active_block')return null;
    if(command.startsWith('get_'))return null;
    if(command.startsWith('mvp_sync_'))return null;
    throw new Error('Unsupported fixture IPC: '+command);
  };
  window.__TAURI__={core:{invoke},event:{listen:async()=>()=>{},emit:async()=>{}}};
}
async function main(){
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,...(process.env.GOALS85_CHROME?{executablePath:process.env.GOALS85_CHROME}:{})});
  const evidence=[];
  try{
    for(const width of [1100,760])for(const theme of ['light','dark']){
      const page=await browser.newPage({viewport:{width,height:720}});const errors=[];
      page.on('pageerror',error=>{errors.push(error.message);fs.writeFileSync(path.join(output,'browser-errors.json'),JSON.stringify(errors,null,2));});
      await page.addInitScript(syntheticBackend,{theme});
      await page.goto('http://127.0.0.1:'+server.address().port,{waitUntil:'networkidle'});
      await page.waitForFunction(()=>window.fixtureReady,null,{timeout:15000});
      const prefix=width+'-'+theme;
      for(const pane of ['dash','tasks','goals']){
        await page.locator('.uni-tab[data-pane="'+pane+'"]').click();
        await page.locator('.uni-tab[data-pane="'+pane+'"][aria-pressed="true"]').waitFor();
        await page.screenshot({path:path.join(output,prefix+'-'+pane+'.png'),fullPage:true});
        evidence.push({width,theme,pane,underlined:await page.locator('button').evaluateAll(nodes=>nodes.filter(n=>n.getClientRects().length&&getComputedStyle(n).textDecorationLine.includes('underline')).map(n=>n.textContent.trim())),text:await page.locator('#calendar-content').innerText()});
      }
      const goal=page.locator('[data-goal-open],.cp-goal-row__open').first();
      await goal.waitFor();
      {
        await goal.click();await page.locator('dialog[open]').waitFor();
        await page.screenshot({path:path.join(output,prefix+'-goal-modal.png'),fullPage:true});
        evidence.push({width,theme,pane:'goal-modal',text:await page.locator('dialog[open]').innerText()});
        await page.keyboard.press('Tab');
        evidence.push({width,theme,focus:await page.evaluate(()=>({tag:document.activeElement.tagName,text:document.activeElement.textContent,outline:getComputedStyle(document.activeElement).outlineStyle}))});
      }
      assert.equal(await page.locator('#calendar-content').evaluate(node=>node.scrollWidth>node.clientWidth+1),false,'workspace horizontal overflow');
      evidence.push({width,theme,errors,calls:await page.evaluate(()=>window.fixtureCalls)});
      fs.writeFileSync(path.join(output,'evidence.json'),JSON.stringify(evidence,null,2));
      await page.close();
    }
  }finally{await browser.close();server.close();}
}
main().catch(error=>{fs.writeFileSync(path.join(output,'failure.txt'),error.stack);server.close();console.error(error);process.exitCode=1;});

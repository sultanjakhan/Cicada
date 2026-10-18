/* Actual Home workspace/CSS, fictional read-only report projection. */
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const project=path.resolve(__dirname,'..'),root=process.env.C86_SOURCE||project,label=process.env.C86_LABEL||'candidate';
const output=path.join(project,'.local/c86-render',label);fs.mkdirSync(output,{recursive:true});
const source=fs.readFileSync(path.join(root,'scripts/qa-goals85-render.cjs'),'utf8');
const fixture=new Function(source.slice(source.indexOf('const fixture ='),source.indexOf('const server ='))+'return fixture;')();
const base=source.slice(source.indexOf('function syntheticBackend'),source.indexOf('async function main()'));
const backend=new Function('return function(options){('+base+')({theme:options.theme});('+function reports({count}){
 const original=window.__TAURI__.core.invoke,namespace='00000000-0000-0000-0000-000000000001';
 window.c86Calls=[];
 const prepared=(async()=>{
  const rows=await original('get_calendar_tasks'),bindings={},runs={};
  const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(namespace));
  const prefix=[...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,'0')).join('').slice(0,16);
  for(let i=0;i<count;i++){
   const id='synthetic-report-task-'+i,key='cicada-'+prefix+'-'+id,runId='synthetic-run-'+String(i).padStart(4,'0'),status=['error','waiting','done'][i%3];
   rows.push({source_type:'note',source_id:id,title:(i===0?'Длинное название учебной задачи с сохранённым результатом и историей — '.repeat(4):'Учебный отчёт '+i),date:'2099-12-31',sphere:'personal',tags:'task-sphere:personal',status_extra:'task',completed:false});
   bindings[key]={sourceNamespace:namespace,sourceType:'note',sourceId:id,taskKey:key};
   const report={runId,sequence:1,taskKey:key,agent:'codex',model:null,provider:null,stage:null,status,skillIds:[],mcpCalls:null,inputTokens:null,outputTokens:null};
   runs[runId]={runId,taskKey:key,agent:'codex',provider:null,model:null,report,receivedOrder:i+1};
  }
  const exchange={version:1,sourceNamespace:namespace,order:count,bindings,runs};window.c86Data={rows,exchange};window.c86OriginalData=JSON.stringify(window.c86Data);return window.c86Data;
 })();
 window.__TAURI__.core.invoke=async(command,args={})=>{
  window.c86Calls.push({command,args:structuredClone(args)});
  if(command==='get_calendar_tasks')return structuredClone((await prepared).rows);
  if(command==='get_ui_state'&&args.key==='calendar_task_run_exchange_v1'){if(window.c86FailReports)throw Error('Synthetic disconnected report read');const exchange=structuredClone((await prepared).exchange);if(window.c86Unreported){const older=exchange.runs['synthetic-run-0000'];exchange.order=25;exchange.runs['synthetic-unreported-run']={...older,runId:'synthetic-unreported-run',report:null,receivedOrder:25};}return exchange;}
  if(command==='get_calendar_task'){const row=(await prepared).rows.find(row=>row.source_id===args.id);if(row)return structuredClone(row);}
  if(command==='shared_task_command'&&args.input?.command==='get'&&args.input.arguments.taskId.startsWith('synthetic-report-task-')){
   const id=args.input.arguments.taskId,index=Number(id.split('-').at(-1));
   if(window.c86ReviewBoundary&&index===0)return {isError:true,status:403,code:'review_prototype_disabled'};
   if(window.c86ReviewBoundary&&index===1)return {id,version:7,binding:{sourceId:id},review:null,results:[],history:[]};
   return {id,version:7,binding:{sourceId:id},review:{state:index%4===0?'awaiting_review':'running',resultVersion:2,intentId:'synthetic-review-intent'},results:[{version:1,content:'Previous synthetic result'},{version:2,content:'Current synthetic result'}],history:[{action:'rework',resultVersion:1,comment:'Preserved synthetic history'}]};
  }
  return original(command,args);
 };
}.toString()+')(options);} ')();
const server=http.createServer((req,res)=>{const name=new URL(req.url,'http://fixture').pathname;if(name==='/'){res.setHeader('Content-Type','text/html');res.end(fixture);return;}const file=path.resolve(root,'.'+name);if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',({'.js':'text/javascript','.json':'application/json','.css':'text/css','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));});
async function main(){assert.equal(process.platform,'linux');assert.ok(process.env.C86_CHROME);await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true,executablePath:process.env.C86_CHROME}),evidence=[];
 try{for(const [width,height] of [[760,720],[1100,800],[390,844]])for(const theme of ['light','dark'])for(const count of [0,24]){
  const name=width+'-'+theme+'-'+count,page=await browser.newPage({viewport:{width,height}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(backend,{theme,count});await page.goto('http://127.0.0.1:'+server.address().port,{waitUntil:'networkidle'});await page.waitForFunction(()=>window.fixtureReady);
  await page.waitForFunction(n=>{const s=document.querySelector('.calendar-ai-reports');return s&&!s.hasAttribute('aria-busy')&&s.querySelectorAll('li').length===n;},count);
  await page.waitForFunction(()=>document.querySelector('[data-ui="goal-title"]')?.textContent.trim()&&!document.querySelector('[data-calendar-next-action]').textContent.includes('Загружаем'));
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>{document.querySelector('.uni-content').scrollTop=0;window.scrollTo(0,0);resolve();}))));
  const box=async selector=>page.locator(selector).first().evaluate(n=>{const r=n.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom};});
  const goalCard=await box('[data-calendar-now]'),goal=await box('[data-ui="goal-title"]'),next=await box('[data-calendar-next-action] [data-next-action-action="start"]'),reports=await box('.calendar-ai-reports');
  const ids=await page.locator('.calendar-ai-reports li').evaluateAll(nodes=>nodes.map(n=>({task:n.dataset.nativeTaskId,run:n.dataset.runId})));
  assert.equal(ids.length,count);assert.equal(new Set(ids.map(x=>x.task)).size,count);assert.deepEqual(errors,[]);
  assert.equal(await page.locator('.calendar-ai-reports details').evaluate(n=>n.open),false);
  if(width>=760){assert.ok(goal.y>=0&&goal.bottom<=height,'selected main goal stays on first screen');assert.ok(next.y>=0&&next.bottom<=height,'next action stays on first screen');}
  const summary=page.locator('.calendar-ai-reports summary');
  if(count){assert.match(await summary.innerText(),/Связанных задач: 24.*ошибок 8, ожидают 8.*на приёмке: 6/);}
  await page.screenshot({path:path.join(output,name+'.png')});
  // Native disclosure: mouse, Enter and Space each expose the same complete projection.
  for(const activation of ['mouse','Enter','Space']){
   if(activation==='mouse')await summary.click();else{await summary.focus();await page.keyboard.press(activation);}
   assert.equal(await page.locator('.calendar-ai-reports details').evaluate(n=>n.open),true);
   if(activation!=='mouse'){const focus=await summary.evaluate(n=>({visible:n.matches(':focus-visible'),width:getComputedStyle(n).outlineWidth}));assert.equal(focus.visible,true);assert.ok(parseFloat(focus.width)>=2);if(activation==='Space')await page.screenshot({path:path.join(output,name+'-disclosure-focus.png')});}
   if(count)assert.equal(await page.locator('.calendar-ai-reports li').count(),24);
   await summary.click();assert.equal(await page.locator('.calendar-ai-reports details').evaluate(n=>n.open),false);
  }
  if(count){
   await summary.click();const open=page.locator('.calendar-ai-reports [data-native-task-id="synthetic-report-task-0"] button');const beforeOpen=await page.evaluate(()=>window.c86Calls.length);await open.focus();await page.keyboard.press('Enter');
   const dialog=page.locator('dialog[open]');await dialog.waitFor();await page.waitForFunction(()=>document.querySelector('.task-result-review')?.textContent.includes('Current synthetic result'));
   assert.match(await dialog.innerText(),/Preserved synthetic history/);assert.equal(await dialog.locator('h2').first().innerText(),await open.innerText());assert.ok((await page.evaluate(start=>window.c86Calls.slice(start),beforeOpen)).some(c=>c.command==='get_calendar_task'&&c.args.id==='synthetic-report-task-0'));
   const audit=dialog.locator('.task-result-review ol');await audit.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(output,name+'-history.png')});
   const accept=dialog.locator('.task-result-review-actions button').first();assert.equal(await accept.isEnabled(),true);await page.keyboard.press('Tab');await accept.focus();assert.equal(await accept.evaluate(n=>n.matches(':focus-visible')),true);await page.screenshot({path:path.join(output,name+'-review-focus.png')});
   const refresh=dialog.locator('.task-result-review-actions button').nth(3);await refresh.focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>document.querySelector('.task-result-review')?.getAttribute('aria-busy')==='false');
   await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});
   await page.waitForFunction(()=>document.activeElement?.closest('li')?.dataset.nativeTaskId==='synthetic-report-task-0');
   await page.screenshot({path:path.join(output,name+'-expanded.png')});await summary.click();
   await page.evaluate(()=>{window.c86FailReports=true;window.dispatchEvent(new Event('task-state-changed'));});await page.waitForFunction(()=>document.querySelector('.calendar-ai-reports summary').textContent.includes('Не удалось прочитать отчёты'));
   assert.equal(await page.locator('.calendar-ai-reports li').count(),0);assert.equal(await page.locator('.calendar-ai-reports details').evaluate(n=>n.open),false);await summary.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(output,name+'-read-error.png')});
   await page.evaluate(()=>{window.c86FailReports=false;window.dispatchEvent(new Event('task-state-changed'));});await page.waitForFunction(()=>document.querySelector('.calendar-ai-reports')?.querySelectorAll('li').length===24);assert.match(await summary.innerText(),/на приёмке: 6/);
   if(width===760&&theme==='dark'){
    await page.evaluate(()=>{window.c86ReviewBoundary=true;window.dispatchEvent(new Event('task-state-changed'));});
    await page.waitForFunction(()=>document.querySelector('.calendar-ai-reports summary').textContent.includes('приёмка неизвестна: 1'));
    assert.match(await summary.innerText(),/на приёмке: 5/);
    const unavailable=page.locator('.calendar-ai-reports [data-native-task-id="synthetic-report-task-0"]');
    assert.match(await unavailable.innerText(),/Состояние приёмки не обновлено/);
    assert.doesNotMatch(await page.locator('.calendar-ai-reports [data-native-task-id="synthetic-report-task-1"]').innerText(),/Состояние приёмки не обновлено/);
    await page.evaluate(()=>{window.c86ReviewBoundary=false;window.c86Unreported=true;window.dispatchEvent(new Event('task-state-changed'));});
    await page.waitForFunction(()=>document.querySelector('.calendar-ai-reports [data-native-task-id="synthetic-report-task-0"]')?.dataset.runId==='synthetic-unreported-run');
    assert.equal(await unavailable.getAttribute('data-result-version'),'2');
    assert.match(await unavailable.innerText(),/Регистрация задачи не означает запуск/);assert.match(await unavailable.innerText(),/На приёмке · результат v2/);
    assert.match(await summary.innerText(),/на приёмке: 6/);assert.doesNotMatch(await summary.innerText(),/приёмка неизвестна/);
    await summary.click();await unavailable.locator('button').click();await page.locator('dialog[open]').waitFor();
    await page.waitForFunction(()=>document.querySelector('.task-result-review')?.textContent.includes('Current synthetic result'));
    assert.match(await page.locator('dialog[open]').innerText(),/Preserved synthetic history/);
    await page.keyboard.press('Escape');await page.locator('dialog[open]').waitFor({state:'detached'});
    await page.waitForFunction(()=>document.activeElement?.closest('li')?.dataset.nativeTaskId==='synthetic-report-task-0');
    await page.screenshot({path:path.join(output,name+'-unreported-review.png')});await summary.click();
    await page.evaluate(()=>{window.c86Unreported=false;window.dispatchEvent(new Event('task-state-changed'));});
    await page.waitForFunction(()=>document.querySelector('.calendar-ai-reports [data-native-task-id="synthetic-report-task-0"]')?.dataset.runId==='synthetic-run-0000');
   }
  }
  assert.equal(await page.evaluate(()=>JSON.stringify(window.c86Data)===window.c86OriginalData),true,'task/run/report data unchanged');
  const writes=await page.evaluate(()=>window.c86Calls.filter(c=>!c.command.startsWith('get_')&&!c.command.startsWith('mvp_sync_')&&c.command!=='read_calendar_day'&&!(c.command==='shared_task_command'&&c.args.input.command==='get')));assert.deepEqual(writes,[],'no task/result/timer/storage writes');
  evidence.push({width,height,theme,count,goalCard,goal,next,reports,disclosure:true,historyReachable:true,noWrites:true,goalVisible:goal.y>=0&&goal.bottom<=height,nextVisible:next.y>=0&&next.bottom<=height,ids,calls:await page.evaluate(()=>window.c86Calls.map(c=>c.command))});await page.close();
 }}finally{fs.writeFileSync(path.join(output,'evidence.json'),JSON.stringify(evidence,null,2));await browser.close();server.close();}console.log(JSON.stringify(evidence.map(({ids,calls,...rest})=>rest)));}
main().catch(error=>{console.error(error);server.close();process.exitCode=1;});

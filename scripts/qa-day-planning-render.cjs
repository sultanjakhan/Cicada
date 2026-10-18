/* Actual production workspace/CSS; isolated synthetic day ledger only. */
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),output=path.join(root,'.local/day-planning-render');fs.mkdirSync(output,{recursive:true});
const source=fs.readFileSync(path.join(root,'scripts/qa-goals85-render.cjs'),'utf8');
const fixture=new Function(source.slice(source.indexOf('const fixture ='),source.indexOf('const server ='))+'return fixture;')();
const base=source.slice(source.indexOf('function syntheticBackend'),source.indexOf('async function main()'));
const backend=new Function('return function(options){('+base+')({theme:options.theme});('+function planning({saved}){
 const original=window.__TAURI__.core.invoke,date=new Date().toISOString().slice(0,10),next=new Date(Date.parse(date)+86400000).toISOString().slice(0,10);
 const model={scope:'device_local',date,local_date:date,offset_minutes:0,next_date:next,token:'a'.repeat(64),day:{closed:false,plan_ids:[],summaries:[]},next_day:{closed:false,plan_ids:saved?['planning-owned-one']:[]},history:[],active_blocks:[{id:9001,source_id:'planning-owned-one',source_type:'note',title:'Owned synthetic timer',seconds:91}],candidates:[{id:'planning-owned-one',title:'Owned unfinished task',deadline:'2099-12-31',version:7},{id:'planning-owned-two',title:'Owned second task',deadline:'2099-11-30',version:3}],ai:{runId:'owned-ai-run',status:'waiting',resultVersion:2}};
 window.planningModel=model;window.planningOriginal=JSON.stringify(model);window.planningCalls=[];
 window.__TAURI__.core.invoke=async(command,args={})=>{
  window.planningCalls.push({command,args:structuredClone(args)});
  if(command==='read_calendar_day'){const value=structuredClone(model);if(args.date===next){value.date=next;value.day=structuredClone(model.next_day);}return value;}
  if(command==='read_calendar_day_operation')return null;
  if(command==='commit_calendar_day_action'){
   const req=args.input;if(req.action==='plan')model.next_day.plan_ids=[...req.task_ids];
   else if(req.action==='close'){model.day.closed=true;model.day.summaries.push({closed_at_utc:new Date().toISOString(),paused_blocks:structuredClone(model.active_blocks)});model.history=[{date,closed:true}];model.active_blocks=[];}
   else if(req.action==='reopen')model.day.closed=false;
   else throw Error('Unexpected synthetic action');
   return {operation_id:req.operation_id,action:req.action};
  }
  return original(command,args);
 };
}.toString()+')(options);} ')();
const server=http.createServer((req,res)=>{const name=new URL(req.url,'http://fixture').pathname;if(name==='/'){res.setHeader('Content-Type','text/html');res.end(fixture);return;}const file=path.resolve(root,'.'+name);if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',({'.js':'text/javascript','.json':'application/json','.css':'text/css','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));});
async function main(){assert.equal(process.platform,'linux');assert.ok(process.env.PLANNING_CHROME);await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true,executablePath:process.env.PLANNING_CHROME}),evidence=[];
 try{for(const width of [760,390])for(const theme of ['light','dark'])for(const saved of [false,true]){
  const page=await browser.newPage({viewport:{width,height:720}}),name=width+'-'+theme+'-'+saved,errors=[];page.on('pageerror',e=>errors.push(e.message));await page.addInitScript(backend,{theme,saved});await page.goto('http://127.0.0.1:'+server.address().port,{waitUntil:'networkidle'});await page.waitForFunction(()=>window.fixtureReady);await page.locator('[data-end-day]:enabled').waitFor();
  assert.equal(await page.locator('.calendar-today [data-next-day-plan]').count(),0);assert.doesNotMatch(await page.locator('.calendar-today').innerText(),/План на завтра/);
  const controls=await page.locator('[data-end-day]').evaluate(end=>{const start=document.querySelector('[data-start-day]'),a=start.getBoundingClientRect(),b=end.getBoundingClientRect();return {sameParent:start.parentElement===end.parentElement,start:{x:a.x,y:a.y,w:a.width,h:a.height},end:{x:b.x,y:b.y,w:b.width,h:b.height}};});assert.equal(controls.sameParent,true);assert.equal(controls.start.y,controls.end.y,'Start/End share one row');
  await page.screenshot({path:path.join(output,name+'-today.png')});
  const calendar=page.locator('.uni-tab[data-pane="table"]');await calendar.click();const plan=page.locator('[data-next-day-plan]');await plan.waitFor();await page.waitForFunction(()=>!document.querySelector('[data-next-day-plan]').disabled);assert.equal(await page.locator('[data-end-day]').count(),0);
  await plan.focus();await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');assert.equal(await plan.evaluate(n=>n===document.activeElement&&n.matches(':focus-visible')),true);assert.ok(parseFloat(await plan.evaluate(n=>getComputedStyle(n).outlineWidth))>=2);
  await page.screenshot({path:path.join(output,name+'-calendar-focus.png')});
  await page.keyboard.press('Enter');const dialog=page.locator('dialog[open]');await dialog.waitFor();assert.equal(await dialog.locator('[value="planning-owned-one"]').isChecked(),saved);const beforeCancel=await page.evaluate(()=>JSON.stringify(window.planningModel));await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});await page.waitForFunction(()=>document.activeElement?.matches('[data-next-day-plan]'));assert.equal(await page.evaluate(()=>JSON.stringify(window.planningModel)),beforeCancel);
  await plan.click();await dialog.waitFor();await dialog.locator('[value="planning-owned-two"]').check();await page.screenshot({path:path.join(output,name+'-planning.png')});await dialog.locator('[type="submit"]').click();await dialog.waitFor({state:'detached'});
  const expected=saved?['planning-owned-one','planning-owned-two']:['planning-owned-two'];const target=await page.evaluate(async()=>{const d=window.planningModel.next_date;return window.__TAURI__.core.invoke('read_calendar_day',{date:d});});assert.deepEqual(target.day.plan_ids,expected);assert.equal(target.date,target.next_date);assert.deepEqual(target.candidates,JSON.parse(beforeCancel).candidates);assert.deepEqual(target.active_blocks,JSON.parse(beforeCancel).active_blocks);assert.deepEqual(target.history,JSON.parse(beforeCancel).history);assert.deepEqual(target.ai,JSON.parse(beforeCancel).ai);
  await plan.click();await dialog.waitFor();assert.equal(await dialog.locator('[data-day-plan-task]:checked').count(),expected.length);await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});
  await page.locator('.uni-tab[data-pane="dash"]').click();await page.locator('[data-end-day]:enabled').waitFor();assert.equal(await page.locator('.calendar-today [data-next-day-plan]').count(),0);await page.locator('[data-end-day]').click();await dialog.waitFor();await dialog.locator('[type="submit"]').click();await dialog.waitFor({state:'detached'});await page.locator('[data-day-summary]:visible').click();await dialog.waitFor();await dialog.locator('[type="submit"]').click();await dialog.waitFor({state:'detached'});
  assert.equal(await page.evaluate(()=>window.planningModel.day.closed),false);assert.deepEqual(await page.evaluate(()=>window.planningModel.active_blocks),[]);assert.deepEqual(await page.evaluate(()=>window.planningModel.ai),JSON.parse(beforeCancel).ai);assert.equal(await page.evaluate(()=>window.planningModel.day.summaries.length),1);
  const writes=await page.evaluate(()=>window.planningCalls.filter(c=>!c.command.startsWith('get_')&&!c.command.startsWith('mvp_sync_')&&!['read_calendar_day','read_calendar_day_operation'].includes(c.command)&&!(c.command==='shared_task_command'&&c.args.input.command==='get')));assert.equal(writes.length,3);assert.deepEqual(writes.map(c=>c.args.input.action),['plan','close','reopen']);assert.ok(writes.every(c=>c.command==='commit_calendar_day_action'));assert.deepEqual(errors,[]);
  // Owned in-memory fixtures only: restore every original field and verify cleanup.
  await page.evaluate(()=>{for(const key of Object.keys(window.planningModel))delete window.planningModel[key];Object.assign(window.planningModel,JSON.parse(window.planningOriginal));localStorage.removeItem('cicada_day_action_pending_v1');});assert.equal(await page.evaluate(()=>JSON.stringify(window.planningModel)===window.planningOriginal),true);assert.equal(await page.evaluate(()=>localStorage.getItem('cicada_day_action_pending_v1')),null);
  evidence.push({width,theme,saved,controls,targetDate:target.date,selectedIds:expected,deadlineAndHistoryPreserved:true,cancelNoWrite:true,keyboardAndFocus:true,reopenNoTimerStart:true,aiUnchanged:true,ownedCleanup:true});await page.close();
 }}finally{fs.writeFileSync(path.join(output,'evidence.json'),JSON.stringify(evidence,null,2));await browser.close();server.close();}console.log(JSON.stringify(evidence));}
main().catch(error=>{console.error(error);server.close();process.exitCode=1;});

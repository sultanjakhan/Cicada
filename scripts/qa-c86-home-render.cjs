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
  return {rows,exchange:{version:1,sourceNamespace:namespace,order:count,bindings,runs}};
 })();
 window.__TAURI__.core.invoke=async(command,args={})=>{
  window.c86Calls.push({command,args:structuredClone(args)});
  if(command==='get_calendar_tasks')return structuredClone((await prepared).rows);
  if(command==='get_ui_state'&&args.key==='calendar_task_run_exchange_v1')return structuredClone((await prepared).exchange);
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
  const box=async selector=>page.locator(selector).first().evaluate(n=>{const r=n.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom};});
  const goal=await box('[data-ui="goal-title"]'),next=await box('[data-calendar-next-action] [data-next-action-action="start"]'),reports=await box('.calendar-ai-reports');
  const ids=await page.locator('.calendar-ai-reports li').evaluateAll(nodes=>nodes.map(n=>({task:n.dataset.nativeTaskId,run:n.dataset.runId})));
  assert.equal(ids.length,count);assert.equal(new Set(ids.map(x=>x.task)).size,count);assert.deepEqual(errors,[]);
  await page.screenshot({path:path.join(output,name+'.png')});
  evidence.push({width,height,theme,count,goal,next,reports,goalVisible:goal.y>=0&&goal.bottom<=height,nextVisible:next.y>=0&&next.bottom<=height,ids,calls:await page.evaluate(()=>window.c86Calls.map(c=>c.command))});await page.close();
 }}finally{fs.writeFileSync(path.join(output,'evidence.json'),JSON.stringify(evidence,null,2));await browser.close();server.close();}console.log(JSON.stringify(evidence.map(({ids,calls,...rest})=>rest)));}
main().catch(error=>{console.error(error);server.close();process.exitCode=1;});

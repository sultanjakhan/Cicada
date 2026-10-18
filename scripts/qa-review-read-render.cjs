/* Hosted cloud only: actual Tasks component and adapter, fictional native IPC. */
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),output=path.join(root,'.local/review-read-render');fs.mkdirSync(output,{recursive:true});
const html=`<!doctype html><html lang="ru"><head><meta charset="utf-8"><link rel="stylesheet" href="/src/styles.css"><link rel="stylesheet" href="/src/hanni/css/calendar-dashboard-v7.css"><link rel="stylesheet" href="/src/hanni/css/ui-actions.css"></head><body><main></main><script type="module">
import {mountCalendarTasks} from '/src/hanni/js/calendar-tasks.js';
import {createSharedResultReviewAdapter} from '/src/hanni/js/shared-result-review-adapter.js';
const id='00000000-0000-4000-8000-000000000001';
const row={source_type:'note',source_id:id,title:'Проверить учебный результат',tags:'task-sphere:personal',sphere:'personal',status_extra:'task',completed:false};
window.mode='success';window.calls=[];
const task={id,version:7,binding:{sourceId:id},review:{state:'running',resultVersion:2,intentId:'synthetic-rework'},results:[{version:1,content:'Первый учебный результат'},{version:2,content:'Текущий учебный результат'}],history:[{decision:'rework',resultVersion:1}]};
const invoke=async(name,args)=>{window.calls.push({name,args});
 if(name==='get_ui_state')return null;
 if(name==='get_calendar_tasks')return [structuredClone(row)];
 if(['get_goals','get_calendar_task_goals','get_calendar_task_blocks'].includes(name))return [];
 if(name==='shared_task_command'){
  if(args.input.command!=='get'||args.input.arguments.taskId!==id)throw Error('Unexpected task command');
  if(window.mode==='denied')return {isError:true,status:403,code:'personal_scope_required'};
  if(window.mode==='transport')throw Error('Synthetic transport failure');
  return structuredClone(task);
 }throw Error('Unexpected IPC '+name);
};
window.refresh=()=>window.dispatchEvent(new Event('task-state-changed'));
window.dispose=mountCalendarTasks(document.querySelector('main'),{invoke,readTaskReview:key=>createSharedResultReviewAdapter(key,invoke).read(key),openTask(){},editDate(){},executeAction(){throw Error('No writes authorized');},notifyChange(){}});
window.fixtureReady=true;
</script></body></html>`;
const server=http.createServer((req,res)=>{const name=new URL(req.url,'http://fixture').pathname;if(name==='/'){res.setHeader('Content-Type','text/html');res.end(html);return;}const file=path.resolve(root,'.'+name);if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'application/octet-stream');res.end(fs.readFileSync(file));});
async function main(){await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true,...(process.env.GOALS85_CHROME?{executablePath:process.env.GOALS85_CHROME}:{})});const evidence=[];
 try{for(const width of [1100,760])for(const theme of ['light','dark']){
  const page=await browser.newPage({viewport:{width,height:720}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(theme=>localStorage.setItem('hanni_theme',theme),theme);await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>window.fixtureReady);
  const row=page.locator('li.ct-row'),retry=page.locator('[data-task-control="review-retry"]'),finish=row.locator('[data-task-control="finish"]');
  await row.waitFor();await page.waitForFunction(()=>!document.querySelector('li.ct-row').textContent.includes('не обновлено'));
  assert.match(await row.textContent(),/В работе/);assert.doesNotMatch(await row.textContent(),/Принято|Завершена|неизвестно/);assert.equal(await finish.isDisabled(),true);
  await page.screenshot({path:path.join(output,width+'-'+theme+'-running.png')});
  for(const failure of ['denied','transport']){
   await page.evaluate(mode=>{window.mode=mode;window.refresh();},failure);await retry.waitFor();assert.match(await row.textContent(),/не обновлено/);assert.equal(await finish.isDisabled(),true);
   await retry.focus();assert.equal(await retry.evaluate(n=>n===document.activeElement),true);
   await page.screenshot({path:path.join(output,width+'-'+theme+'-'+failure+'.png')});
   await page.keyboard.press('Enter');await page.waitForFunction(()=>document.activeElement?.dataset.taskControl==='review-retry');assert.equal(await retry.isVisible(),true,'persistent failure retains retry and focus');
   await page.evaluate(()=>{window.mode='success';});await page.keyboard.press('Enter');await retry.waitFor({state:'detached'});
   await page.waitForFunction(()=>document.activeElement?.dataset.taskControl==='open');assert.doesNotMatch(await row.textContent(),/не обновлено|неизвестно|Принято/);assert.equal(await finish.isDisabled(),true);
  }
  await page.screenshot({path:path.join(output,width+'-'+theme+'-recovered.png')});
  const calls=await page.evaluate(()=>window.calls);assert.ok(calls.every(c=>c.name.startsWith('get_')||c.name==='shared_task_command'&&c.args.input.command==='get'));assert.deepEqual(errors,[]);
  evidence.push({width,theme,running:true,denial:true,transport:true,keyboardRetry:true,focusRestored:true,noMutations:true});await page.close();
 }}finally{fs.writeFileSync(path.join(output,'evidence.json'),JSON.stringify(evidence,null,2));await browser.close();server.close();}console.log(JSON.stringify(evidence));}
main().catch(e=>{console.error(e);server.close();process.exitCode=1;});

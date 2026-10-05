import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {copyForLanguage} from '../src/hanni/js/ui-copy.js';
import {mountTaskWorkflow} from '../src/hanni/js/task-workflow-view.js';
import {createWorkflowStore} from '../src/hanni/js/task-workflow.js';
import {mountTaskResultReview} from '../src/hanni/js/task-result-review.js';
import {mountSyncSettings} from '../src/hanni/js/sync-settings.js';
import {mountSyncConflicts} from '../src/hanni/js/sync-conflicts.js';
import {mountDataSources,defaultDataSources,DATA_SOURCES_KEY} from '../src/hanni/js/data-sources.js';
import {mountPersonalTaskImport,personalImportErrorText} from '../src/hanni/js/personal-task-import-view.js';
import {mountSleepSettings,sleepStatusText} from '../src/hanni/js/health-sleep.js';
import {mountHealthActivitySettings,walkingStatusText,stepsStatusText} from '../src/hanni/js/health-activity.js';
import {mountProcessSettings} from '../src/hanni/js/calendar-process-settings.js';
import {mountWorkRegistry} from '../src/hanni/js/work-registry-view.js';
import {registryStatusLabel,registryFreshnessLabel} from '../src/hanni/js/work-registry-labels.js';
const cyrillic=/[\u0400-\u04ff]/;
const settle=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));};
function fixture(t){const dom=new JSDOM('<html lang="en-US"><main></main></html>',{url:'https://fixture.invalid'});t.after(()=>dom.window.close());return {dom,host:dom.window.document.querySelector('main')};}

test('English workflow localizes status and actions while preserving stored step/result strings',async t=>{
 const {dom,host}=fixture(t),values=new Map(),calls=[],record={source_type:'note',source_id:'synthetic-localized'};
 const invoke=async(command,args)=>{calls.push([command,args]);if(command==='get_ui_state')return values.get(args.key)??null;if(command==='set_ui_state'){assert.equal(args.expectedValue,values.get(args.key)??'');values.set(args.key,args.value);return;}throw Error(command);};
 const store=createWorkflowStore(record,invoke,()=> 'synthetic-step');
 const userText='\u0428\u0430\u0433\u0438 \u0438 \u0440\u0435\u0437\u0443\u043b\u044c\u0442\u0430\u0442';
 await store.addStep(userText);await store.saveResult(userText);calls.length=0;
 const stop=mountTaskWorkflow(host,{record,invoke});t.after(stop);await settle();
 assert.equal(host.querySelector('summary').textContent,'Steps and result · completed 0 of 1');
 assert.equal(host.querySelector('li span').textContent,userText);assert.equal(host.querySelector('textarea').value,userText);
 assert.deepEqual([...host.querySelector('select').options].map(o=>o.textContent),['Planned','In progress','Waiting for a response','Done']);
 assert.deepEqual([...host.querySelector('select').options].map(o=>o.value),['planned','running','blocked','done']);
 assert.match(host.querySelector('.task-next-step > p').textContent,/Next step:/);
 assert.ok(calls.every(([c])=>c==='get_ui_state'));
 host.querySelector('input').value='new draft';assert.throws(()=>stop.beforeClose(),/Save the step or result before closing/);
 const discard=[...host.querySelectorAll('button')].find(b=>b.textContent==='Discard input');discard.click();assert.doesNotThrow(()=>stop.beforeClose());
});

test('English sync keeps native connection facts, counters and disabled policy without writes',async t=>{
 const {dom,host}=fixture(t),calls=[];
 const status={configured:true,enabled:true,pending:2,conflicts:1,running:false,last_success:'2026-10-03T12:00:00Z'};
 const stop=mountSyncSettings(host,{invoke:async command=>{calls.push(command);return status;}});t.after(stop);await settle();
 assert.match(host.querySelector('[data-sync-status]').textContent,/Connection enabled/);
 assert.equal(host.querySelector('[data-sync-counts]').textContent,'Pending to send: 2 · Conflicts: 1');
 assert.match(host.querySelector('[data-sync-success]').textContent,/Last successful exchange:/);
 assert.doesNotMatch(host.querySelector('[data-sync-success]').textContent,cyrillic);
 assert.equal(host.querySelector('[data-sync-code]').type,'password');assert.equal(host.querySelector('[data-sync-code]').value,'');
 assert.equal(host.querySelector('[data-sync-save]').hidden,true);
 dom.window.dispatchEvent(new dom.window.CustomEvent('hanni:sync-status',{detail:{...status,last_error:'mvp_sync_credentials_unavailable'}}));
 assert.match(host.querySelector('[data-sync-error]').textContent,/Local data is preserved/);
 dom.window.dispatchEvent(new dom.window.CustomEvent('hanni:sync-status',{detail:{...status,configured:false,last_error:null}}));
 assert.match(host.querySelector('[data-sync-status]').textContent,/not connected yet/);
 assert.equal(host.querySelector('[data-sync-now]').hidden,true);
 assert.deepEqual(calls,['mvp_sync_status']);
});

test('English conflict captions preserve native preview labels and values and exact read contract',async t=>{
 const {host}=fixture(t),calls=[],userText='\u0421\u0438\u043d\u0445\u0440\u043e\u043d\u0438\u0437\u0430\u0446\u0438\u044f';
 const item={token:'t',expected:'e',source:'pending',label:userText,can_keep_current:true,can_use_incoming:false,reason:'mvp_sync_conflict_deleted',current:{state:'present',fields:[{label:userText,value:userText}]},incoming:{state:'deleted',fields:[]}};
 const control=mountSyncConflicts(host,{invoke:async(command,args)=>{calls.push([command,args]);return {total:1,entries:[item]};}});t.after(()=>control.dispose());
 await control.refresh();host.querySelector('[data-conflicts-list] button').click();
 assert.equal(host.querySelector('h4').textContent,userText);assert.equal(host.querySelector('strong').textContent,userText+': ');
 assert.match(host.querySelector('[data-conflicts-detail]').textContent,/A saved version cannot undo deletion/);
 assert.equal(host.querySelector('[data-conflicts-keep]').textContent,'Keep current');
 assert.equal(host.querySelector('[data-conflicts-use]').disabled,true);
 assert.deepEqual(calls,[['mvp_sync_conflicts_list',{offset:0,limit:25}]]);
});

test('English sources and personal import captions do not rewrite stored paths or import errors',async t=>{
 const {host,dom}=fixture(t),calls=[],source=defaultDataSources(),path='C:\\'+ '\u0414\u0430\u043d\u043d\u044b\u0435';source.sources[0].path=path;
 const stop=mountDataSources(host,{invoke:async(command,args)=>{calls.push([command,args]);return JSON.stringify(source);}});t.after(stop);await settle();
 assert.equal(host.querySelector('summary').textContent,'Data and sources');
 assert.equal(host.querySelector('input[type="text"]').value,path);
 assert.doesNotMatch(host.querySelector('pre').textContent,cyrillic);assert.match(host.querySelector('pre').textContent,/\n<app>-data\/manifest.json/);
 assert.deepEqual([...host.querySelector('select').options].map(o=>o.value),['tasks','projects']);
 assert.deepEqual(calls,[['get_ui_state',{key:DATA_SOURCES_KEY}]]);
 const extra=dom.window.document.createElement('section');host.append(extra);
 const stopImport=mountPersonalTaskImport(extra,{invoke:async()=>{throw Error('No import action expected');}});t.after(stopImport);
 for(const node of extra.querySelectorAll('summary,button,label'))assert.doesNotMatch(node.textContent,cyrillic);
 assert.equal(personalImportErrorText(path,'en'),path);
});

test('English health settings cover ready, unsupported and permission facts without import side effects',async t=>{
 const {host,dom}=fixture(t),calls=[];
 const statuses=[null,{status:'unsupported'},{status:'provider_unavailable'},{status:'permission_requested'},{status:'foreground_required'},{status:'error'},{status:'permission_required'},{status:'ready',walkingPermissionGranted:true,stepsPermissionGranted:true},{status:'ready',lastSuccess:'2026-10-03',walkingPermissionGranted:true,stepsPermissionGranted:true,walkingLastSuccess:'2026-10-03',stepsLastSuccess:'2026-10-03',records:1,walkingRecords:1,stepsRecords:2}];
 for(const status of statuses)for(const format of [sleepStatusText,walkingStatusText,stepsStatusText])assert.doesNotMatch(format(status,'en'),cyrillic);
 const sleep=dom.window.document.createElement('section'),activity=dom.window.document.createElement('section');host.append(sleep,activity);
 const invoke=async command=>{calls.push(command);return{status:'unsupported'};};
 const stopSleep=mountSleepSettings(sleep,{invoke}),stopActivity=mountHealthActivitySettings(activity,{invoke});t.after(stopSleep);t.after(stopActivity);await settle();
 assert.match(sleep.textContent,/Sleep is imported from Health Connect/);assert.match(activity.textContent,/Walks and steps are imported from Health Connect/);
 assert.deepEqual(calls,['health_sleep_status','health_activity_status']);
});

test('English review localizes decisions and queue facts while preserving service content and comments',async t=>{
 const {host}=fixture(t),calls=[],userText='\u0420\u0435\u0437\u0443\u043b\u044c\u0442\u0430\u0442 \u043f\u0440\u0438\u043d\u044f\u0442';
 const drafts=new Map([['synthetic',{comment:userText}]]);
 const stop=mountTaskResultReview(host,{taskId:'synthetic',drafts,operationId:()=> 'operation',adapter:{read:async id=>{calls.push(id);return{taskId:id,taskRevision:1,resultVersion:2,content:userText,history:[],reviewState:'awaiting_review'};},submit:async()=>{throw Error('No submission expected');}}});t.after(stop);await settle();
 assert.equal(host.querySelector('pre').textContent,userText);assert.equal(host.querySelector('textarea').value,userText);
 assert.match(host.querySelector('.task-result-review').textContent,/Result · revision 2 · task version 1/);
 assert.deepEqual([...host.querySelectorAll('button')].map(b=>b.textContent),['Accept','Request rework','Cancel decision','Refresh result','Retry submission']);assert.deepEqual(calls,['synthetic']);
});

test('English process validation is display-only and registry enum labels stay compatible',async t=>{
 const {host}=fixture(t),calls=[];
 const control=mountProcessSettings(host,{invoke:async command=>{calls.push(command);return null;}});t.after(()=>control.dispose());await settle();
 const field=host.querySelector('[data-control="process-title"]'),original=field.value;
 assert.equal(host.querySelector('legend').textContent,'Built-in process');
 assert.equal(host.querySelector('.calendar-processes-hint').textContent,'Stages for tasks with a process. Renaming does not change tasks. Deleting a stage makes its tasks show Deleted stage until you select another one.');
 field.value='';field.dispatchEvent(new host.ownerDocument.defaultView.Event('input',{bubbles:true}));
 assert.equal(control.check(),false);assert.equal(host.querySelector('[data-processes-error]').textContent,'Name the process.');
 assert.deepEqual(calls,['get_ui_state']);assert.ok(original.length>0);
 assert.equal(registryStatusLabel('waiting','en'),'Waiting');assert.equal(registryFreshnessLabel('stale','en'),'Stale observation');
 const extra=host.ownerDocument.createElement('section');host.append(extra);
 const stop=mountWorkRegistry(extra,{invoke:async()=>null});t.after(stop);await settle();
 assert.equal(extra.querySelector('summary').textContent,'Imported work registry');
});


test('English fallback preserves inherited-property names and other unknown values',()=>{
 const copy=copyForLanguage('en');
 for(const value of ['constructor','toString','__proto__','hasOwnProperty','unknown native error','',null,undefined]) assert.equal(copy(value),value);
 assert.equal(copy('\u041d\u0430\u0441\u0442\u0440\u043e\u0439\u043a\u0438'),'Settings');
});

test('English process panel renders inherited-name native errors literally without writes',async t=>{
 for(const message of ['constructor','toString','__proto__']){
  const {host}=fixture(t),calls=[];
  const control=mountProcessSettings(host,{invoke:async(command,args)=>{calls.push([command,args]);throw Error(message);}});
  t.after(()=>control.dispose());await settle();
  const error=host.querySelector('[data-processes-error]');
  assert.equal(error.textContent,message);assert.equal(error.hidden,false);
  assert.deepEqual(calls,[['get_ui_state',{key:'calendar_processes_v1'}]]);
 }
});

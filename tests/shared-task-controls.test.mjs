import test from 'node:test';import assert from 'node:assert/strict';import {JSDOM} from 'jsdom';import {mountSharedTaskControls} from '../src/hanni/js/shared-task-controls.js';
const settle=async()=>{for(let n=0;n<6;n++)await new Promise(r=>setImmediate(r));};
test('sharing preserves native ID, saves retry before send and never launches work',async()=>{
 const dom=new JSDOM('<body><section></section></body>'),host=dom.window.document.querySelector('section'),state=new Map(),calls=[],sent=[];let drop=true,bound=false;
 const invoke=async(cmd,args)=>{calls.push([cmd,args]);if(cmd==='get_ui_state')return state.get(args.key)??null;if(cmd==='set_ui_state'){if('expectedValue'in args)assert.equal(state.get(args.key)??null,args.expectedValue);state.set(args.key,args.value);return;}
  if(cmd==='get_calendar_task')return {version:4};assert.equal(cmd,'shared_task_command');const v=args.input;if(v.command==='get')return bound?{binding:{sourceId:'native-existing'}}:{isError:true,status:404,code:'shared_task_not_found'};
  assert.equal(v.command,'share');assert.ok(state.get('calendar_shared_binding_pending_v1:native-existing'));sent.push(v);bound=true;if(drop){drop=false;throw Error('lost response');}return {acknowledged:true,operationId:v.operationId,task:{id:'native-existing'}};
 };
 let stop=mountSharedTaskControls(host,{record:{source_type:'note',source_id:'native-existing',sphere:'personal'},invoke,operationId:()=> 'ui-share-001'});await settle();host.querySelector('button').click();await settle();assert.match(host.textContent,/не подтверждено/);stop();
 stop=mountSharedTaskControls(host,{record:{source_type:'note',source_id:'native-existing',sphere:'personal'},invoke,operationId:()=> 'unused-id'});await settle();host.querySelector('button').click();await settle();assert.deepEqual(sent[0],sent[1]);assert.equal(sent[0].arguments.taskId,'native-existing');assert.equal(sent[0].arguments.expectedVersion,4);assert.equal(calls.some(([cmd])=>/start|begin|report/.test(cmd)),false);stop();dom.window.close();
});
test('unrelated work or readonly records never access sharing commands',()=>{const dom=new JSDOM('<body><section></section></body>'),host=dom.window.document.querySelector('section');for(const record of [{source_type:'note',source_id:'work',sphere:'work'},{source_type:'note',source_id:'readonly',sphere:'personal',readonly:true}])mountSharedTaskControls(host,{record,invoke:()=>{throw Error('must not read');}})();assert.equal(host.children.length,0);dom.window.close();});



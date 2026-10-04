import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountPersonalTaskImport, personalImportErrorText } from '../src/hanni/js/personal-task-import-view.js';
const raw=JSON.stringify({schemaVersion:1,kind:'personal-native-tasks',namespace:'personal-backlog',tasks:[{externalId:'synthetic',title:'Synthetic <img onerror=fixture>',projects:[],status:'planned',operation:'Synthetic action',waitingFor:'',result:'',dependsOn:[]}],archiveTemplates:[]});
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
function boot(payload=raw){
  const dom=new JSDOM('<section></section>',{url:'http://fixture.local'});const d=dom.window.document;const notes=new Map();const writes=[];const exports=[];let changed=0;let saveFailure=null;let readFailure=null;
  const invoke=async(command,args={})=>{
    if(command==='get_notes'){if(readFailure)throw readFailure;return [...notes.values()].filter(n=>n.tags.split(',').includes(args.search));}
    if(command==='get_note')return structuredClone(notes.get(args.id));
    if(command==='save_personal_import_recovery'){if(saveFailure)throw saveFailure;exports.push(JSON.parse(args.reportJson));return {schemaVersion:1,path:'synthetic/backups/report.json',sha256:'a'.repeat(64),bytes:new TextEncoder().encode(args.reportJson).length,verified:true};}
    writes.push(command);
    if(command==='create_backup')return 'fixture-backup';
    if(command==='create_note'){notes.set('fixture',{id:'fixture',version:1,...args,archived:false,completed:false});return {schemaVersion:1,id:'fixture',created:true,marker:args.tags.split(',').find(t=>t.startsWith('personal-import:'))};}
    throw new Error('Unexpected mutation');
  };
  const dispose=mountPersonalTaskImport(d.querySelector('section'),{invoke,onChanged:()=>changed++});
  const input=d.querySelector('input[type=file]');Object.defineProperty(input,'files',{value:[{size:new TextEncoder().encode(payload).length,text:async()=>payload}]});
  const [preview,exportButton,apply]=[...d.querySelectorAll('button')];
  return {dom,d,notes,writes,exports,preview,exportButton,apply,dispose,changed:()=>changed,saveFailure:value=>saveFailure=value,readFailure:value=>readFailure=value};
}
test('native verified export gates writes and persists all recovery phases',async()=>{
  const x=boot();try{
    assert.equal(x.d.querySelector('details').open,false);assert.equal(x.apply.disabled,true);
    x.preview.click();await tick();assert.equal(x.writes.length,0);assert.equal(x.d.querySelectorAll('img').length,0);assert.match(x.d.querySelector('ul').textContent,/Synthetic action/);
    x.exportButton.click();await tick();assert.equal(x.exports.length,1);assert.match(x.d.querySelector('[role=status]').textContent,/сохранён и проверен/);assert.equal(x.apply.disabled,true);
    const checkbox=x.d.querySelector('input[type=checkbox]');checkbox.checked=true;checkbox.dispatchEvent(new x.dom.window.Event('change'));assert.equal(x.apply.disabled,false);
    x.apply.click();await tick();await tick();assert.deepEqual(x.writes,['create_backup','create_note']);assert.equal(x.notes.size,1);assert.equal(x.changed(),1);assert.equal(x.apply.disabled,true);
    assert.ok(x.exports.some(r=>r.backup==='fixture-backup'&&r.phase==='prepared'));assert.equal(x.exports.at(-1).phase,'complete');
  }finally{x.dispose();x.dom.window.close();}
});
test('invalid file retains no writable preview and disposal removes action',async()=>{
  const x=boot('{"kind":1,"kind":2}');try{x.preview.click();await tick();assert.equal(x.writes.length,0);assert.equal(x.exportButton.disabled,true);assert.equal(x.apply.disabled,true);assert.match(x.d.querySelector('[role=status]').textContent,/Повторяющееся/);x.dispose();assert.equal(x.d.querySelector('details'),null);}finally{x.dom.window.close();}
});
test('native export failure is visible, safely blocked and retryable',async()=>{
  const x=boot();try{
    x.preview.click();await tick();x.saveFailure('Synthetic native save failed');x.exportButton.click();await tick();
    assert.match(x.d.querySelector('[role=status]').textContent,/Не удалось сохранить экспорт/);assert.equal(x.apply.disabled,true);assert.equal(x.d.querySelector('input[type=checkbox]').disabled,true);assert.equal(x.exportButton.disabled,false);assert.equal(x.writes.length,0);
    x.saveFailure(null);x.exportButton.click();await tick();assert.equal(x.d.querySelector('input[type=checkbox]').disabled,false);assert.equal(x.apply.disabled,true);
  }finally{x.dispose();x.dom.window.close();}
});
test('QA-IMP-NATIVE003 string/Error/fallback are visible in RU/EN and preview remains blocked',async()=>{
  for(const lang of ['ru','en']){
    assert.equal(personalImportErrorText('scope conflict',lang),'scope conflict');assert.equal(personalImportErrorText(new Error('version conflict'),lang),'version conflict');assert.ok(personalImportErrorText(null,lang).length>0);
    const x=boot();try{x.d.documentElement.lang=lang;x.readFailure('personal import scope changed');x.preview.click();await tick();assert.match(x.d.querySelector('[role=status]').textContent,/personal import scope changed/);assert.equal(x.apply.disabled,true);assert.equal(x.writes.length,0);}finally{x.dispose();x.dom.window.close();}
  }
});

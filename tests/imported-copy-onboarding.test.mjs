import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {mountTaskWorkflow} from '../src/hanni/js/task-workflow-view.js';
import {mountWorkRegistry} from '../src/hanni/js/work-registry-view.js';
import {createRegistryStore} from '../src/hanni/js/work-registry.js';
import {createTaskRunExchange,stableTaskBinding} from '../src/hanni/js/task-run-exchange.js';
import {mountSourceOnboarding,DATA_SOURCES_KEY} from '../src/hanni/js/data-sources.js';
const tick=()=>new Promise(resolve=>setTimeout(resolve,20));
const expected={planned:'Запланировано',running:'В работе',waiting:'Ожидание',checking:'Проверка','decision-needed':'Нужно решение',done:'Готово',error:'Ошибка',cancelled:'Отменено',unknown:'Неизвестно'};
async function registry(status,{future=false}={}){
 const values=new Map(),calls=[],record={source_type:'note',source_id:'synthetic-label-task'};
 const invoke=async(cmd,a)=>{calls.push(cmd);if(cmd==='get_calendar_task')return {id:a.id};if(cmd==='get_ui_state')return values.get(a.key)??'';if(cmd==='set_ui_state'){assert.equal(a.expectedValue,values.get(a.key)??'');values.set(a.key,a.value);return;}throw Error(cmd);};
 const namespace='11111111-1111-4111-8111-111111111111',exchange=createTaskRunExchange(invoke,()=>namespace);await exchange.prepareSource();await exchange.bindTask(record);
 const date=future?'2099-01-01T00:00:00Z':'2000-01-01T00:00:00Z';
 const snapshot={schemaVersion:1,kind:'work-registry-snapshot',snapshotId:'synthetic-copy',sequence:1,source:{publisherId:'synthetic-parent',sourceNamespace:namespace,mode:'published-snapshot'},publishedAt:date,staleAfterSeconds:60,projects:[{id:'p',title:'Synthetic project'}],tasks:[{id:'t',projectId:'p',parentTaskId:null,title:'Synthetic task',relationship:'root',status,lastUpdated:date,provenance:{kind:'parent-published',reference:'synthetic-evidence'},operation:null,waitingFor:null,result:null,localBinding:await stableTaskBinding(namespace,record)}],runs:[]};
 await createRegistryStore(invoke).import(JSON.stringify(snapshot));calls.length=0;
 return {invoke,calls,record,values};
}
test('imported task copy translates every recorded status without implying live execution or writing',async()=>{
 for(const [status,label] of Object.entries(expected)){
  const e=await registry(status),dom=new JSDOM('<main></main>'),host=dom.window.document.querySelector('main');const stop=mountTaskWorkflow(host,{record:e.record,invoke:e.invoke});await tick();
  try{assert.match(host.textContent,new RegExp('Импортированный отчёт — '+label));assert.match(host.textContent,/Устаревшее наблюдение/);assert.match(host.textContent,/Источник отчёта: synthetic-parent/);assert.match(host.textContent,/Основание: synthetic-evidence/);assert.match(host.textContent,/Автоматическое выполнение не запускалось/);assert.ok(e.calls.every(c=>c==='get_ui_state'));}finally{stop();dom.window.close();}
 }
});
test('future observation stays unknown and registry preview uses the same readable status',async()=>{
 const e=await registry('checking',{future:true}),dom=new JSDOM('<main></main>'),host=dom.window.document.querySelector('main');const stop=mountTaskWorkflow(host,{record:e.record,invoke:e.invoke});await tick();
 try{assert.match(host.textContent,/Свежесть неизвестна/);assert.doesNotMatch(host.textContent,/Свежее наблюдение/);}finally{stop();host.replaceChildren();}
 const dispose=mountWorkRegistry(host,{invoke:e.invoke});await tick();try{assert.match(host.textContent,/Synthetic task — Проверка/);assert.match(host.textContent,/Свежесть неизвестна/);assert.doesNotMatch(host.textContent,/checking • unknown/);assert.ok(e.calls.every(c=>c==='get_ui_state'));}finally{dispose();dom.window.close();}
});
test('eligible onboarding has neutral product controls while save failure keeps the choice available',async()=>{
 const dom=new JSDOM('<main></main>',{pretendToBeVisual:true}),host=dom.window.document.querySelector('main');let writes=0;
 const invoke=async(cmd,a)=>{if(cmd==='get_ui_state')return a.key==='cicada_sources_onboarding_eligible_v1'?'true':'';assert.equal(cmd,'set_ui_state');assert.equal(a.key,DATA_SOURCES_KEY);writes++;throw Error('synthetic write failure');};
 const stop=mountSourceOnboarding(host,{invoke,onSettings:()=>{throw Error('Must not navigate on failed save');}});await tick();
 try{const section=host.querySelector('.source-onboarding');assert.ok(section);const setup=section.querySelector('.btn-primary'),skip=section.querySelector('.btn-secondary');assert.equal(setup.textContent,'Настроить источники');assert.equal(skip.textContent,'Пропустить');assert.equal(writes,0);skip.focus();assert.equal(dom.window.document.activeElement,skip);skip.click();await tick();assert.equal(writes,1);assert.ok(host.contains(section));assert.equal(skip.disabled,false);assert.match(section.textContent,/Не удалось сохранить выбор/);}finally{stop();dom.window.close();}
});

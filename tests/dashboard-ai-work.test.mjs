import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {groupAiWork,mountDashboardAiWork} from '../src/hanni/js/dashboard-ai-work.js';
const tick=()=>new Promise(r=>setTimeout(r,5));
const tasks=()=>Array.from({length:11},(_,i)=>({taskKey:`bound-${i}`,title:`Synthetic AI ${i}`,project:i<6?{id:'p1',name:'Project One'}:{id:'p2',name:'Project Two'},tags:i%2?[{id:'b',name:'Backend'},{id:'a',name:'Analysis'}]:[{id:'b',name:'Backend'}],needsUser:i===1,resultVersion:i===1?2:null,reviewState:i===1?'awaiting_review':null}));
const reports=()=>[{taskKey:'bound-0',runId:'reported-run',agent:'codex',model:'reported-model',stage:'Review',status:'running',receivedAt:'2026-10-03T10:00:00Z',freshness:'stale'}];
function setup(read){const dom=new JSDOM('<section id="now">My human focus</section><main></main>'),doc=dom.window.document,opened=[];const stop=mountDashboardAiWork(doc.querySelector('main'),{read,onOpenTask:key=>opened.push(key)});return{dom,doc,stop,opened};}
test('11 tasks group by project once; multi-tag primary grouping does not duplicate totals',()=>{
 const rows=tasks();assert.deepEqual(groupAiWork(rows).map(g=>g.tasks.length),[6,5]);const tags=groupAiWork(rows,'tag');assert.equal(tags.reduce((n,g)=>n+g.tasks.length,0),11);assert.equal(new Set(tags.flatMap(g=>g.tasks.map(t=>t.taskKey))).size,11);
 assert.equal(groupAiWork(rows,'tag','a').flatMap(g=>g.tasks).length,5);assert.equal(groupAiWork(rows,'project','b').flatMap(g=>g.tasks).length,11);
});
test('dashboard rows preserve personal Now, show reported model/result and unknown current execution',async()=>{
 const x=setup(async()=>({tasks:tasks(),reports:reports()}));await tick();assert.equal(x.doc.querySelector('#now').textContent,'My human focus');assert.equal(x.doc.querySelectorAll('[data-ai-task]').length,11);assert.equal(x.doc.querySelectorAll('details').length,1);assert.match(x.doc.querySelector('main').textContent,/Текущее выполнение не подтверждено/);assert.match(x.doc.querySelector('main').textContent,/reported-model/);assert.match(x.doc.querySelector('[data-ai-task="bound-1"]').textContent,/Нужно ваше решение.*Результат v2.*на приёмке/);assert.match(x.doc.querySelector('[data-ai-task="bound-0"]').textContent,/отчёт устарел/);
 x.doc.querySelector('[data-ai-task="bound-1"] button').click();assert.deepEqual(x.opened,['bound-1']);x.stop();x.dom.window.close();
});
test('tag switch keeps multi-tag tasks accessible and filtered group sums exact',async()=>{
 const x=setup(async()=>({tasks:tasks(),reports:[]}));await tick();const [mode,tag]=x.doc.querySelectorAll('select');mode.value='tag';mode.dispatchEvent(new x.dom.window.Event('change'));assert.equal(x.doc.querySelectorAll('[data-ai-task]').length,11);tag.value='a';tag.dispatchEvent(new x.dom.window.Event('change'));assert.equal(x.doc.querySelectorAll('[data-ai-task]').length,5);assert.match(x.doc.querySelector('main').textContent,/Задач: 11.*Показано: 5/);x.stop();x.dom.window.close();
});
test('no feed differs from authoritative empty fixture; human timer cannot imply AI running',async()=>{
 const x=setup(null);assert.match(x.doc.querySelector('main').textContent,/пока недоступны/);assert.equal(x.doc.querySelector('.dashboard-ai-work__counts').hidden,true);x.stop();x.dom.window.close();
 const y=setup(async()=>({tasks:[{...tasks()[0],is_active:true}],reports:[]}));await tick();assert.match(y.doc.querySelector('main').textContent,/Текущее выполнение не подтверждено/);assert.match(y.doc.querySelector('main').textContent,/Отчёт исполнителя ещё не получен/);y.stop();y.dom.window.close();
 const z=setup(async()=>({tasks:[],reports:[]}));await tick();assert.match(z.doc.querySelector('main').textContent,/Пока нет связанных отчётов ИИ/);z.stop();z.dom.window.close();
});
test('unbound report does not match a title; unknown needsUser does not become badge',async()=>{
 const row={...tasks()[0],title:'Same title',needsUser:null};const x=setup(async()=>({tasks:[row],reports:[{...reports()[0],taskKey:'not-bound',model:'must-not-appear'}]}));await tick();assert.doesNotMatch(x.doc.querySelector('main').textContent,/must-not-appear/);assert.equal(x.doc.querySelector('strong'),null);assert.match(x.doc.querySelector('main').textContent,/необходимость приёмки неизвестна/);x.stop();x.dom.window.close();
});
test('duplicate identity fails closed; disposed late source cannot replace dashboard',async()=>{
 assert.throws(()=>groupAiWork([tasks()[0],tasks()[0]]));const x=setup(async()=>({tasks:[tasks()[0],tasks()[0]],reports:[]}));await tick();assert.match(x.doc.querySelector('main').textContent,/Не удалось обновить/);x.stop();x.dom.window.close();let resolve;const y=setup(()=>new Promise(r=>resolve=r));y.stop();resolve({tasks:tasks(),reports:reports()});await tick();assert.equal(y.doc.querySelector('main').childNodes.length,0);y.dom.window.close();
});

test('pending source read has visible loading, unknown counts and clears loading after receipt',async()=>{
 let resolve;const x=setup(()=>new Promise(r=>resolve=r));
 assert.equal(x.doc.querySelector('section.dashboard-ai-work').getAttribute('aria-busy'),'true');
 assert.match(x.doc.querySelector('[role=status]').textContent,/Загружаем сведения о работе ИИ/);
 assert.equal(x.doc.querySelector('.dashboard-ai-work__counts').hidden,true);
 assert.equal(x.doc.querySelector('main button').disabled,true);
 resolve({tasks:tasks(),reports:reports()});await tick();
 assert.equal(x.doc.querySelector('section.dashboard-ai-work').hasAttribute('aria-busy'),false);
 assert.doesNotMatch(x.doc.querySelector('[role=status]').textContent,/Загружаем/);
 assert.match(x.doc.querySelector('[role=status]').textContent,/Текущее выполнение не подтверждено/);
 x.stop();x.dom.window.close();
});

test('empty and failed views offer existing Tasks without leaking internal protocol jargon',async()=>{
 for(const read of [async()=>({tasks:[],reports:[]}),async()=>{throw Error('secret transport diagnostic');}]){const dom=new JSDOM('<main></main>');let opened=0;const stop=mountDashboardAiWork(dom.window.document.querySelector('main'),{read,onOpenTasks:()=>opened++});await tick();const section=dom.window.document.querySelector('.dashboard-ai-work');assert.equal(section.querySelector('.dashboard-ai-work__filters').hidden,true);section.querySelector('.dashboard-ai-work__all-tasks').click();assert.equal(opened,1);assert.doesNotMatch(section.textContent,/Live|Running|actual model|reported:|secret transport/);assert.equal(section.querySelector('.dashboard-ai-work__counts').hidden,true);stop();dom.window.close();}
});
test('refresh failure clears stale rows and retry restores truthful data',async()=>{
 let fail=false;const x=setup(async()=>{if(fail)throw Error('unavailable');return{tasks:tasks(),reports:reports()};});await tick();fail=true;x.doc.querySelector('.dashboard-ai-work__refresh').click();await tick();assert.equal(x.doc.querySelectorAll('[data-ai-task]').length,0);assert.equal(x.doc.querySelector('.dashboard-ai-work').dataset.state,'error');fail=false;x.doc.querySelector('.dashboard-ai-work__refresh').click();await tick();assert.equal(x.doc.querySelectorAll('[data-ai-task]').length,11);x.stop();x.dom.window.close();
});

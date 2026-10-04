import {dashboardFromNativeTasks,nativeTaskKey} from '../src/hanni/js/native-task-observations.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {mountDashboardWorkViews} from '../src/hanni/js/dashboard-work-views.js';
const source=readFileSync(new URL('../src/hanni/js/calendar-workspace.js',import.meta.url),'utf8');
const markup=source.match(/pane.innerHTML = `(<section class="calendar-today"[\s\S]*?)`;/)[1];
test('AI view is inside Today and both panels have associated accessible tabs',()=>{
 const dom=new JSDOM(markup),doc=dom.window.document,host=doc.querySelector('.calendar-today'),stop=mountDashboardWorkViews(host),tabs=[...host.querySelectorAll('[role=tab]')];
 const widget=doc.querySelector('[data-calendar-task-widget]');assert.ok(widget.contains(doc.querySelector('[data-calendar-ai-work]')));assert.ok(widget.contains(doc.querySelector('[data-calendar-today-tasks]')));assert.equal(doc.querySelector('[data-calendar-next-action]').closest('[data-work-panel]'),null);assert.equal(doc.querySelector('[data-calendar-in-progress]').closest('[data-work-panel]'),null);assert.equal(doc.querySelector('[data-calendar-day-banner]').closest('[data-work-panel]'),null);assert.equal(widget.querySelector('h2').textContent,'Задачи на сегодня');assert.ok(host.contains(doc.querySelector('[data-calendar-next-action]')));assert.equal(doc.querySelectorAll('[data-calendar-ai-work]').length,1);assert.equal(doc.querySelector('[data-calendar-now-slot]').closest('.calendar-today'),null);
 for(const tab of tabs){const panel=doc.getElementById(tab.getAttribute('aria-controls'));assert.equal(panel.getAttribute('aria-labelledby'),tab.id);assert.equal(panel.getAttribute('role'),'tabpanel');}
 assert.equal(tabs[0].getAttribute('aria-selected'),'true');assert.equal(tabs[1].tabIndex,-1);stop();dom.window.close();
});
test('switching by click, arrows, Home, End preserves personal DOM and execution identity',()=>{
 const dom=new JSDOM(markup),doc=dom.window.document,host=doc.querySelector('.calendar-today'),stop=mountDashboardWorkViews(host),tabs=[...host.querySelectorAll('[role=tab]')],personal=host.querySelector('[data-work-panel=personal]'),ai=host.querySelector('[data-work-panel=ai]'),focus=doc.createElement('div');focus.dataset.taskId='same-native-task';personal.append(focus);
 const current=host.querySelector('[data-calendar-in-progress]'),recommendation=host.querySelector('[data-calendar-next-action]');tabs[1].click();assert.equal(current.closest('[hidden]'),null);assert.equal(recommendation.closest('[hidden]'),null);assert.equal(personal.hidden,true);assert.equal(ai.hidden,false);assert.equal(personal.lastChild,focus);tabs[1].focus();tabs[1].dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));assert.equal(doc.activeElement,tabs[0]);assert.equal(personal.hidden,false);
 tabs[0].dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'End',bubbles:true}));assert.equal(doc.activeElement,tabs[1]);tabs[1].dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Home',bubbles:true}));assert.equal(doc.activeElement,tabs[0]);stop.select('ai');stop.select('personal');assert.equal(personal.lastChild,focus);stop();tabs[1].click();assert.equal(personal.hidden,false);dom.window.close();
});
test('dashboard stylesheet is loaded through existing Today design and uses theme tokens',()=>{
 const today=readFileSync(new URL('../src/hanni/css/calendar-today.css',import.meta.url),'utf8'),css=readFileSync(new URL('../src/hanni/css/dashboard-ai-work.css',import.meta.url),'utf8');assert.match(today,/@import url\('\.\/dashboard-ai-work.css'\)/);assert.match(css,/aria-selected="true"/);assert.match(css,/var\(--bg-card/);assert.match(css,/focus-visible/);assert.match(css,/max-width:480px/);
});

test('ordinary native task progress/results do not fabricate AI linkage or completion',()=>{
 const rows=Array.from({length:19},(_,i)=>({source_type:'note',source_id:`synthetic-${i}`,title:`Personal task ${i}`,status_extra:'task'})),contexts=new Map(rows.map(row=>[nativeTaskKey(row),{reports:[],review:null,projects:[],tags:[],workflow:{steps:[{status:'running'}],result:'Prepared personal result'}}]));
 const before=JSON.stringify(rows);assert.deepEqual(dashboardFromNativeTasks(rows,contexts),{tasks:[],reports:[]});assert.equal(JSON.stringify(rows),before);assert.equal(rows.length,19);
 const ctx=contexts.get(nativeTaskKey(rows[0]));ctx.review={reviewState:'awaiting_review',resultVersion:2};assert.equal(dashboardFromNativeTasks(rows,contexts).tasks.length,1);assert.equal(dashboardFromNativeTasks(rows,contexts).tasks[0].taskKey,'synthetic-0');assert.equal(dashboardFromNativeTasks(rows,contexts).tasks[0].needsUser,true);
});

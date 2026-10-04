import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {mountDashboardAiWork} from '../src/hanni/js/dashboard-ai-work.js';
const cssPath=new URL('../src/hanni/css/',import.meta.url),read=name=>readFileSync(new URL(name,cssPath),'utf8');
// Same relevant production order as independent design QA; not browser/reflow evidence.
const css=read('calendar-next-action.css')+read('dashboard-ai-work.css')+read('calendar-today.css').replace(/^@import.*$/m,'');
const fixture=()=>new JSDOM('<style>'+css+'</style><section class="calendar-today"><div class="calendar-today-action__scopes calendar-work-views"><button>Моя работа</button><button>Работа ИИ</button></div><main></main></section>',{pretendToBeVisual:true});
const row={taskKey:'design-fixture',title:'Synthetic task',project:null,tags:[{id:'unicode',name:'Тег🙂漢字'.repeat(40)}],needsUser:null};
const report={taskKey:'design-fixture',status:'done',agent:'Synthetic executor',model:'Synthetic model',freshness:'unknown'};
const tick=()=>new Promise(r=>setTimeout(r,10));
test('DQA-001 Today view spacing survives later base styles; narrow rules deliberately override base selectors',()=>{
 const dom=fixture(),doc=dom.window.document,style=dom.window.getComputedStyle(doc.querySelector('.calendar-work-views'));assert.equal(style.margin,'0px 0px 18px');assert.equal(dom.window.getComputedStyle(doc.querySelector('.calendar-work-views button')).minHeight,'44px');
 const sheet=doc.querySelector('style').sheet,narrow=[...sheet.cssRules].find(rule=>rule.conditionText?.includes('max-width:480px')&&[...rule.cssRules].some(item=>item.selectorText==='.calendar-today .calendar-work-views'));assert.ok(narrow);const rules=[...narrow.cssRules],switchRule=rules.find(r=>r.selectorText==='.calendar-today .calendar-work-views'),buttonRule=rules.find(r=>r.selectorText==='.calendar-today .calendar-work-views button');assert.equal(switchRule.style.getPropertyValue('display'),'flex');assert.equal(switchRule.style.getPropertyValue('width'),'100%');assert.equal(parseFloat(buttonRule.style.getPropertyValue('min-width')),0);assert.equal(buttonRule.style.getPropertyValue('padding'),'7px 10px');dom.window.close();
});
test('DQA-002 report disclosure declares 44px target and retains native focus/open/repeat behavior',async()=>{
 const dom=fixture(),doc=dom.window.document,stop=mountDashboardAiWork(doc.querySelector('main'),{read:async()=>({tasks:[row],reports:[report]})});try{await tick();const summary=doc.querySelector('.dashboard-ai-work summary'),details=summary.parentElement,style=dom.window.getComputedStyle(summary);assert.equal(style.minHeight,'44px');assert.equal(style.boxSizing,'border-box');assert.equal(style.display,'list-item');summary.focus();assert.equal(doc.activeElement,summary);summary.click();assert.equal(details.open,true);summary.click();assert.equal(details.open,false);assert.equal(doc.querySelector('[data-ai-task]').dataset.aiTask,row.taskKey);}finally{stop();dom.window.close();}
});
test('DQA-003 unbroken Unicode tag content is preserved with explicit wrapping and bounded width',async()=>{
 const dom=fixture(),doc=dom.window.document,before=JSON.stringify(row),stop=mountDashboardAiWork(doc.querySelector('main'),{read:async()=>({tasks:[row],reports:[]})});try{await tick();const tag=doc.querySelector('.dashboard-ai-work__tags'),style=dom.window.getComputedStyle(tag);assert.ok(tag.textContent.length>200);assert.equal(tag.textContent,row.tags[0].name);assert.equal(style.whiteSpace,'normal');assert.equal(style.overflowWrap,'anywhere');assert.equal(style.display,'block');assert.equal(style.maxWidth,'100%');assert.equal(JSON.stringify(row),before);}finally{stop();dom.window.close();}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
const source=readFileSync(new URL('../src/hanni/js/calendar-workspace.js',import.meta.url),'utf8'),markup=source.match(/pane.innerHTML = `(<section class="calendar-today"[\s\S]*?)`;/)[1];
const settle=async()=>{for(let i=0;i<15;i++)await new Promise(r=>setImmediate(r));};
test('portable QA mounts actual Today components with synthetic reports, empty/error/loading states',async()=>{
 for(const scenario of ['reports','long-content','empty','error','loading','unavailable']){
  const dom=new JSDOM('<main></main>',{url:'https://synthetic-fixture.test',pretendToBeVisual:true});const previous={window:globalThis.window,document:globalThis.document,localStorage:globalThis.localStorage,marked:globalThis.marked};Object.assign(globalThis,{window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,marked:{Marked:class{use(){} parse(value){return value;}}}});
  const {mountDashboardComponentFixture}=await import('../scripts/dashboard-component-fixture.js');let stop;
  try{stop=mountDashboardComponentFixture(dom.window.document.querySelector('main'),{markup,scenario});await settle();const doc=dom.window.document,banner=doc.querySelector('.calendar-day-banner');assert.ok(doc.querySelector('.calendar-today-action'));assert.ok(doc.querySelector('.calendar-in-progress'));assert.equal(doc.querySelector('[data-calendar-running]').nextElementSibling.dataset.homeTheme,'');assert.equal(banner.querySelector('[data-home-theme]'),null);assert.equal(doc.querySelector('[data-home-theme]').closest('.calendar-today'),null);assert.ok(doc.querySelector('[role=tablist]'));const ai=doc.querySelector('.dashboard-ai-work');if(scenario==='long-content')assert.equal(ai.querySelector('.dashboard-ai-work__tags').textContent,'Тег🙂漢字'.repeat(40));assert.equal(ai.dataset.state,['reports','long-content'].includes(scenario)?'ready':scenario==='unavailable'?'unavailable':scenario);assert.equal(doc.querySelector('[data-work-panel=ai]').hidden,false);doc.querySelector('[data-work-view=personal]').click();assert.equal(doc.querySelector('[data-work-panel=personal]').hidden,false);assert.ok(stop.calls.every(c=>c.name.startsWith('get_')||(c.name==='set_ui_state'&&c.args?.key==='calendar_now_v1')));assert.equal(doc.querySelectorAll('[data-calendar-task-widget] .calendar-task-overview').length,1);assert.equal(doc.querySelector('[data-calendar-in-progress]').closest('[hidden]'),null);}
  finally{stop?.();dom.window.close();for(const [key,value]of Object.entries(previous)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
 }
});

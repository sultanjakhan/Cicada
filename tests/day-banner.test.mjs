import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {mountCalendarDayBanner} from '../src/hanni/js/calendar-day-banner.js';
test('day start stays acknowledged without offering an undo action',async t=>{
  const dom=new JSDOM('<div id="host"></div>',{url:'http://localhost',pretendToBeVisual:true});
  let saved=null,writes=0;
  const invoke=async(command,args)=>{if(command==='get_ui_state')return saved;if(command==='set_ui_state'){writes++;saved=args.value;return;}throw Error(command);};
  const host=dom.window.document.querySelector('#host'),dispose=mountCalendarDayBanner(host,{invoke,now:()=>new Date(2026,8,14,8,5)});
  t.after(()=>{dispose();dom.window.close();});
  const tick=()=>new Promise(r=>setImmediate(r));await tick();
  assert.equal(host.querySelector('[data-undo-day]'),null);assert.equal(host.querySelectorAll('button').length,1);
  host.querySelector('[data-start-day]').click();await tick();await tick();
  assert.equal(writes,1);assert.equal(JSON.parse(saved).entries.length,1);assert.match(host.textContent,/День начат/);
  assert.equal(host.querySelector('[data-start-day]').disabled,true);
  host.querySelector('[data-start-day]').click();await tick();assert.equal(writes,1);
});

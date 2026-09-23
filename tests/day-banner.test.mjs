import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {mountCalendarDayBanner} from '../src/hanni/js/calendar-day-banner.js';
test('day start stays acknowledged without offering an undo action',async t=>{
  const dom=new JSDOM('<div id="host"></div>',{url:'http://localhost',pretendToBeVisual:true});
  let saved=null,writes=0;
  const invoke=async(command,args)=>{if(command==='get_ui_state')return saved;if(command==='start_calendar_day'){writes++;saved=JSON.stringify({version:1,entries:[{id:'day-a',started_at_utc:new Date(2026,8,14,8,5).toISOString()}]});return JSON.parse(saved);}throw Error(command);};
  const host=dom.window.document.querySelector('#host'),dispose=mountCalendarDayBanner(host,{invoke,now:()=>new Date(2026,8,14,8,5)});
  t.after(()=>{dispose();dom.window.close();});
  const tick=()=>new Promise(r=>setImmediate(r));await tick();
  assert.equal(host.querySelector('[data-undo-day]'),null);assert.equal(host.querySelectorAll('button:not([hidden])').length,1);
  host.querySelector('[data-start-day]').click();await tick();await tick();
  assert.equal(writes,1);assert.equal(JSON.parse(saved).entries.length,1);assert.match(host.textContent,/День начат/);
  assert.equal(host.querySelector('[data-start-day]').disabled,true);
  host.querySelector('[data-start-day]').click();await tick();assert.equal(writes,1);
});

test('same-day sync refresh acknowledges a remote start without writing or replacing the banner', async t => {
  const dom = new JSDOM('<div id="host"></div>', { pretendToBeVisual:true }); let raw = null, writes = 0;
  const now = () => new Date(2026,8,14,12);
  const host = dom.window.document.querySelector('#host');
  const dispose = mountCalendarDayBanner(host, { now, invoke:async command => { if (command === 'get_ui_state') return raw; writes++; } });
  t.after(() => { dispose(); dom.window.close(); });
  await new Promise(resolve => setImmediate(resolve)); const button = host.querySelector('[data-start-day]');
  raw = JSON.stringify({ version:1,entries:[{id:'remote-day',started_at_utc:new Date(2026,8,14,8,15).toISOString()}] });
  dom.window.dispatchEvent(new dom.window.Event('hanni:calendar-refresh'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(host.querySelector('[data-start-day]'), button); assert.equal(button.disabled,true); assert.match(button.textContent,/08:15/); assert.equal(writes,0);
});

test('an old in-flight read cannot erase an acknowledged atomic day start', async t => {
  const dom = new JSDOM('<div id="host"></div>', { pretendToBeVisual:true }); let delayed = false, release;
  const day = {version:1,entries:[{id:'atomic',started_at_utc:new Date(2026,8,14,8,5).toISOString()}]};
  const host = dom.window.document.querySelector('#host'); let stored = null;
  const dispose = mountCalendarDayBanner(host, { now:() => new Date(2026,8,14,12), invoke:async command => {
    if(command==='start_calendar_day'){stored=JSON.stringify(day);return day;}
    if(delayed){delayed=false;return new Promise(resolve=>{release=()=>resolve(null);});}return stored;
  } });
  t.after(() => { dispose(); dom.window.close(); }); const tick=()=>new Promise(resolve=>setImmediate(resolve));await tick();
  delayed=true;dom.window.dispatchEvent(new dom.window.Event('focus'));host.querySelector('[data-start-day]').click();await tick();
  release();await tick();assert.match(host.textContent,/День начат/);assert.equal(host.querySelector('[data-start-day]').disabled,true);
});

test('banner keeps today, the date and the start action on one row', async t => {
  const dom = new JSDOM('<div id="host"></div>', { pretendToBeVisual:true });
  const host = dom.window.document.querySelector('#host');
  const dispose = mountCalendarDayBanner(host, { now:() => new Date(2026,8,23,9), invoke:async () => null });
  t.after(() => { dispose(); dom.window.close(); });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(host.querySelector('.today-date h2').textContent, 'Сегодня · 23 сентября, среда');
  assert.equal(host.querySelector('time').dateTime, '2026-09-23');
  assert.equal(host.querySelector('[data-start-day]').parentElement, host);
  assert.equal(host.querySelector('small'), null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { appendDigitalActivityDetails } from '../src/hanni/js/digital-activity-details.js';

test('daily activity details separate missing AFK from zero and escape application names', t => {
  const dom = new JSDOM('<main></main>'); t.after(() => dom.window.close());
  const root = dom.window.document.querySelector('main');
  appendDigitalActivityDetails(root, { activity_summary: { foreground_seconds: 5700, active_seconds: null, apps: { '<img src=x onerror=alert(1)>': 300, Reader: 5400 } } });
  assert.match(root.textContent, /1 ч 35 мин/);
  assert.match(root.textContent, /Без статуса AFK: нет данных/);
  assert.equal(root.querySelector('img'), null);
  assert.equal(root.querySelector('tbody tr td').textContent, 'Reader');
  root.replaceChildren();
  appendDigitalActivityDetails(root, { activity_summary: { foreground_seconds: 60, active_seconds: 0, apps: {} } });
  assert.match(root.textContent, /Без статуса AFK: 0 с/);
});

test('an imported event leads to management of its connection, including a disconnected source',t=>{
  const dom=new JSDOM('<main></main>');t.after(()=>dom.window.close());
  const root=dom.window.document.querySelector('main'),seen=[];
  const id='550e8400-e29b-41d4-a716-446655440000';
  appendDigitalActivityDetails(root,{source_id:`digital-activity:${id}:2026-09-20`,title:'Тестовый дневной итог'},{onManageHistory:target=>seen.push(target)});
  root.querySelector('button').click();assert.deepEqual(seen,[{id,label:'Тестовый дневной итог'}]);
  root.replaceChildren();appendDigitalActivityDetails(root,{id:'unrelated-event'},{onManageHistory:target=>seen.push(target)});
  assert.equal(root.querySelector('button'),null);
});

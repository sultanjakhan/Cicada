import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountCalendarDashboardTasks } from '../src/hanni/js/calendar-dashboard-tasks.js';

const task = (id, values = {}) => ({ source_type:'note', source_id:id, title:`Задача ${id}`, status_extra:'task', date:'2026-09-12', duration_minutes:30, ...values });
async function mount(t, rows, now = () => new Date('2026-09-12T12:00:00')) {
  const dom = new JSDOM('<main></main>'), host = dom.window.document.querySelector('main');
  const dispose = mountCalendarDashboardTasks(host, { invoke:async () => rows, now });
  t.after(() => { dispose(); dom.window.close(); });
  await new Promise(resolve => setImmediate(resolve));
  return { host, dispose, window:dom.window, q:name => host.querySelector(`[data-overview-${name}]`) };
}

test('Today shows all five other tasks; All includes current and other dates without duplicate visible lists', async t => {
  const rows = [task('current'), ...Array.from({length:5},(_,i) => task(String(i))), task('later',{date:'2026-09-13'}), task('undated',{date:null}), task('done',{completed:true}), task('archived',{archived:true}), task('event',{source_type:'event'}), task('readonly',{readonly:true})];
  const x = await mount(t,rows); x.dispose.setCurrentTask({key:'note:current',state:'recommendation'});
  assert.equal(x.q('today-count').textContent,'5');
  assert.equal(x.q('all-count').textContent,'8');
  assert.equal(x.q('today').querySelectorAll('li').length,5);
  assert.equal(x.q('more'),null);
  assert.equal(x.q('today').textContent.includes('сент.'),false);
  assert.equal(x.q('today').textContent.includes('30 мин'),true);
  x.q('toggle').click();
  assert.equal(x.q('today').hidden,true);
  assert.equal(x.q('all').hidden,false);
  assert.equal(x.q('all').querySelectorAll('li').length,8);
  assert.match(x.q('all').textContent,/Сейчас/);
  x.q('today-filter').click();
  assert.equal(x.q('today').hidden,false);
  assert.equal(x.q('all').hidden,true);
});

test('important badge is limited to native note tasks and appears in Today and All', async t => {
  const rows = [task('important', { priority: 5 }), task('ordinary', { priority: 4 }), task('missing'), task('nan', { priority: 'oops' }), task('later', { priority: 5, date: '2026-09-13' }), task('event', { source_type: 'event', priority: 5 })];
  const x = await mount(t, rows);
  assert.equal(x.q('today').querySelectorAll('[data-important-badge]').length, 1);
  assert.equal(x.q('today').textContent.includes('Важная'), true);
  assert.equal(x.q('today').querySelector('li.task-important [data-important-badge]').textContent,'Важная задача');
  assert.equal(x.q('today').querySelectorAll('li.task-important').length,1);
  x.q('toggle').click();
  assert.equal(x.q('all').querySelectorAll('[data-important-badge]').length, 2);
  assert.match(x.q('all').textContent, /later/);
});

test('important task follows its planned date across midnight and rescheduling', async t => {
  let clock = new Date('2026-09-12T23:59:00');
  const rows = [task('important', { priority: 5 })];
  const x = await mount(t, rows, () => clock);
  assert.equal(x.q('today').querySelectorAll('[data-important-badge]').length, 1);
  clock = new Date('2026-09-13T00:01:00');
  x.window.dispatchEvent(new x.window.Event('focus'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(x.q('today').querySelectorAll('[data-overview-task]').length, 0);
  x.q('toggle').click();
  assert.equal(x.q('all').querySelectorAll('[data-important-badge]').length, 1);
  rows[0].date = '2026-09-13';
  x.window.dispatchEvent(new x.window.Event('task-state-changed'));
  await new Promise(resolve => setImmediate(resolve));
  x.q('today-filter').click();
  assert.equal(x.q('today').querySelectorAll('[data-important-badge]').length, 1);
});

test('Today excludes current from rows and count only when it is on today', async t => {
  const rows = [task('current'), task('other'), task('paused',{has_work:true})];
  const x = await mount(t,rows);
  x.dispose.setCurrentTask({key:'note:current',state:'paused'});
  assert.equal(x.q('today-count').textContent,'2');
  assert.equal(x.q('today').querySelectorAll('li').length,2);
  x.dispose.setCurrentTask({key:'note:missing',state:'paused'});
  assert.equal(x.q('today-count').textContent,'3');
  assert.equal(x.q('today').querySelectorAll('li').length,3);
  x.dispose.setCurrentTask({key:'note:other-date',state:'paused'});
  assert.equal(x.q('today-count').textContent,'3');
  x.dispose.setCurrentTask({key:'note:current',state:'paused'});
  x.dispose.setDate('2026-09-11');
  assert.equal(x.q('today-count').textContent,'0');
  assert.equal(x.q('today').querySelectorAll('li').length,0);
});

test('Today paginates its own rows and a completion refresh updates both counters', async t => {
  const rows = Array.from({length:52},(_,i) => task(String(i)));
  const x = await mount(t,rows);
  assert.equal(x.q('today').querySelectorAll('li').length,50);
  x.q('next').click();
  assert.equal(x.q('today').querySelectorAll('li').length,2);
  assert.equal(x.q('page').textContent,'51–52 из 52');
  rows[51].completed=true;
  x.window.dispatchEvent(new x.window.Event('task-state-changed'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(x.q('today').querySelectorAll('li').length,1);
  assert.equal(x.q('today-count').textContent,'51');
  assert.equal(x.q('all-count').textContent,'51');
  x.q('toggle').click();
  assert.equal(x.q('page').textContent,'1–50 из 51');
});

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { CalendarViews } from '../src/hanni/js/calendar-views.js';
import { mountCalendarDayBanner } from '../src/hanni/js/calendar-day-banner.js';
const tick = async () => { for (let i=0;i<10;i++) await new Promise(resolve => setImmediate(resolve)); };
const windows = new Set();
afterEach(() => { for(const window of windows) { window.document.querySelectorAll('dialog').forEach(dialog => dialog.close()); window.close(); } windows.clear(); });
async function boot({ failPreferenceSave = false, stalePreferenceSave = false, failPreferenceLoad = false, delayPreferenceLoad = false, deferProcessSave = false, initialPreferences = null, section = 'next-action', recommendationsOnly = false, lang = 'ru', theme = 'light' } = {}) {
  const dom = new JSDOM('<button id="settings">Настройки</button>', { url: 'http://cicada.local', pretendToBeVisual: true });
  windows.add(dom.window);
  dom.window.document.documentElement.lang = lang;
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
    CustomEvent: dom.window.CustomEvent, FormData: dom.window.FormData,
  });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new dom.window.Event('close')); };
  globalThis.marked = { Marked: class { use() {} parse(value) { return value; } } };

  const ui = new Map(), writes = [], calls = [];
  if (initialPreferences) ui.set('calendar_preferences_v1', JSON.stringify(initialPreferences));
  let preferenceFailures = failPreferenceLoad ? 1 : 0;
  let resolvePreferenceLoad = null, deferredPreferenceUsed = false, resolveProcessSave = null;
  dom.window.__TAURI__ = { core: { invoke: async (command, args = {}) => {
    calls.push(command);
    if (command === 'get_ui_state') {
      if (args.key === 'calendar_preferences_v1') {
        if (preferenceFailures > 0) { preferenceFailures--; throw Error('preferences offline'); }
        if (delayPreferenceLoad && !deferredPreferenceUsed) {
          deferredPreferenceUsed = true;
          return new Promise(resolve => { resolvePreferenceLoad = () => resolve(ui.get(args.key) ?? null); });
        }
      }
      return ui.get(args.key) ?? null;
    }
    if (command === 'get_app_setting') return null;
    if (command === 'set_ui_state') {
      writes.push(args.key);
      if (stalePreferenceSave && args.key === 'calendar_preferences_v1') throw Error('mvp_sync_stale_ui_state');
      if (failPreferenceSave && args.key === 'calendar_preferences_v1') throw Error('preferences offline');
      if (deferProcessSave && args.key === 'calendar_processes_v1') {
        return new Promise(resolve => { resolveProcessSave = () => { ui.set(args.key, args.value); resolve(null); }; });
      }
      if (args.expectedValue !== undefined && args.expectedValue !== (ui.get(args.key) ?? '')) throw Error('mvp_sync_stale_ui_state');
      ui.set(args.key, args.value); return null;
    }
    if (command === 'mvp_sync_status') return { configured: true, enabled: true, pending: 0, conflicts: 0, running: false };
    if (command === 'health_sleep_status') return { status: 'unsupported' };
    if (command === 'health_activity_status') return { status: 'unsupported' };
    if (command === 'mvp_update_status') return { installed_version: '0.3.35', configured: false, phase: 'idle' };
    if (command === 'mvp_sync_set_enabled') return { configured: true, enabled: args.enabled, pending: 0, conflicts: 0, running: false };
    throw Error(command);
  } } };

  const state = await import('../src/hanni/js/state.js');
  state.setTheme(theme);
  const module = await import(`../src/hanni/js/calendar-settings.js?${Math.random()}`);
  module.showCalendarSettings(document.querySelector('#settings'), { section, recommendationsOnly });
  await tick();
  return { dom, ui, writes, calls, modal: document.querySelector('dialog'),
    resolvePreferenceLoad: () => resolvePreferenceLoad?.(), resolveProcessSave: () => resolveProcessSave?.() };
}

test('native Settings keeps five sections and accessible RU/EN choice; acknowledged language survives reopening', async () => {
  const x=await boot({ section:'calendar' });
  assert.equal(x.modal.querySelectorAll('[role="tab"]').length,5);
  const group=x.modal.querySelector('[data-key="language"]');
  assert.equal(group.closest('fieldset').querySelector('legend').textContent,'Язык интерфейса');
  assert.deepEqual([...group.querySelectorAll('button')].map(b=>b.textContent),['Русский','English']);
  assert.equal(group.querySelector('[data-value="ru"]').getAttribute('aria-pressed'),'true');
  let changed=0; x.dom.window.addEventListener('hanni:language-changed',()=>changed++);
  group.querySelector('[data-value="en"]').click();
  assert.equal(document.documentElement.lang,'ru','draft does not apply or claim saved');
  x.modal.querySelector('form').dispatchEvent(new x.dom.window.Event('submit',{bubbles:true,cancelable:true}));
  await tick(); assert.equal(document.documentElement.lang,'en');assert.equal(changed,1);
  assert.equal(JSON.parse(x.ui.get('calendar_preferences_v1')).language,'en');
  const module=await import(`../src/hanni/js/calendar-settings.js?${Math.random()}`);
  module.showCalendarSettings(document.querySelector('#settings'),{section:'calendar'});await tick();
  const reopened=document.querySelector('[data-key="language"]');
  assert.equal(reopened.closest('fieldset').querySelector('legend').textContent,'Interface language');
  assert.equal(reopened.querySelector('[data-value="en"]').getAttribute('aria-pressed'),'true');
});

test('Settings write failure retains RU language and EN draft, with an error instead of saved status', async () => {
  const x=await boot({section:'calendar',failPreferenceSave:true});
  x.modal.querySelector('[data-key="language"] [data-value="en"]').click();
  x.modal.querySelector('form').dispatchEvent(new x.dom.window.Event('submit',{bubbles:true,cancelable:true}));
  await tick(); assert.equal(document.documentElement.lang,'ru');assert.equal(x.modal.open,true);
  assert.equal(x.modal.querySelector('[data-prefs-error]').hidden,false);
  assert.equal(x.modal.querySelector('[data-key="language"] [data-value="en"]').getAttribute('aria-pressed'),'true');
  assert.equal(x.ui.has('calendar_preferences_v1'),false);
});

test('mounted calendar month/day labels follow RU/EN and preserve a Cyrillic user title', () => {
  for(const language of ['ru','en']) {
    const dom=new JSDOM(`<html lang="${language}"><main></main></html>`,{url:'https://fixture.invalid'});windows.add(dom.window);
    Object.assign(globalThis,{document:dom.window.document,window:dom.window});
    const host=document.querySelector('main'),title='Сегодня';
    CalendarViews.render(host,{period:'month',date:'2026-10-07',firstDay:'mon',records:[{id:'fixture',source_type:'note',source_id:'fiction',date:'2026-10-07',title,time:'12:00',durationMinutes:30}],dayStarts:[]});
    assert.equal(host.querySelector('.calv-weekday').textContent,language==='en'?'Mon':'Пн');
    assert.equal(host.querySelector('strong').textContent,title);
    const formatted=CalendarViews.label('2026-10-07');
    assert.match(formatted,language==='en'?/October/:/октябр/);
  }
});

test('mounted day banner localizes date and actions without writing the day domain',async()=>{
  for(const language of ['ru','en']) {
    const dom=new JSDOM(`<html lang="${language}"><main></main></html>`,{url:'https://fixture.invalid'});windows.add(dom.window);
    const host=dom.window.document.querySelector('main'),calls=[];
    const stop=mountCalendarDayBanner(host,{now:()=>new Date('2026-10-07T12:00:00'),invoke:async(command)=>{calls.push(command);return JSON.stringify({version:1,entries:[]});}});
    await tick();assert.equal(host.querySelector('[data-start-day]').textContent,language==='en'?'Start day':'Начать день');
    assert.equal(host.querySelector('.today-date__label').textContent,language==='en'?'Today':'Сегодня');
    assert.match(host.querySelector('time').textContent,language==='en'?/October/:/октябр/);
    assert.deepEqual(calls,['get_ui_state']);stop();
  }
});

for (const lang of ['ru','en']) test(`Settings ${lang} stale save localizes error and retains the draft without success`, async () => {
  const x=await boot({lang,section:'calendar',stalePreferenceSave:true,initialPreferences:{language:lang}});
  const old=x.ui.get('calendar_preferences_v1');
  assert.equal(x.modal.querySelector('[data-key="density"]'), null, 'Compact density is absent in both locales');
  x.modal.querySelector('[data-key="first_day"] [data-value="sun"]').click();
  x.modal.querySelector('form').dispatchEvent(new x.dom.window.Event('submit',{bubbles:true,cancelable:true}));
  await tick();
  assert.equal(x.modal.open,true);assert.equal(x.ui.get('calendar_preferences_v1'),old);
  assert.equal(x.modal.querySelector('[data-key="first_day"] [data-value="sun"]').getAttribute('aria-pressed'),'true');
  const error=x.modal.querySelector('[data-prefs-error]').textContent;
  assert.match(error,lang==='en'?/Settings changed/:/Настройки изменились/);
  assert.doesNotMatch(error,/another device|другом устройстве/);
});

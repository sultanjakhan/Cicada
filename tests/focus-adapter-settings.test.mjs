import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { FOCUS_ADAPTER_KEY, emptyFocusConfig, validateFocusConfig, focusRecipe, mountFocusAdapterSettings } from '../src/hanni/js/focus-adapter-settings.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const example = () => ({...emptyFocusConfig(), sites: 'example.com video.example.com', exceptions: 'chat.example.com mail.example.com', times: '0900-1200,1300-1700', days: [1, 2, 3, 4, 5]});
async function boot(initial = '', fail = {}) {
  const dom = new JSDOM('<section></section>'), host = dom.window.document.querySelector('section');
  let raw = initial; const calls = [], pending = [];
  const invoke = async (command, args) => {
    calls.push({command, ...args});
    assert.equal(args.key, FOCUS_ADAPTER_KEY);
    if (command === 'get_ui_state') { if (fail.read) throw Error('unavailable'); return raw; }
    assert.equal(command, 'set_ui_state');
    if (fail.write) throw Error('unavailable');
    if (args.expectedValue !== raw) throw Error('stale');
    raw = args.value; if (fail.afterWrite) { fail.read = true; throw Error('outcome unknown'); }
  };
  const dispose = mountFocusAdapterSettings(host, {invoke, setPending: value => pending.push(value)});
  await tick();
  const q = selector => host.querySelector(selector), action = key => q(`[data-focus-action="${key}"]`);
  const edit = config => { for (const key of ['platform', 'sites', 'exceptions', 'times']) q(`[data-focus-field="${key}"]`).value = config[key]; for (const input of host.querySelectorAll('[data-focus-day]')) input.checked = config.days.includes(Number(input.dataset.focusDay)); q('[data-focus-field="sites"]').dispatchEvent(new dom.window.Event('input', {bubbles: true})); };
  return {host, q, action, edit, dispose, calls, pending, fail, raw: () => raw, remote: value => {raw = value;}};
}

test('opening reads only its local configuration and never writes or assumes protection', async () => {
  const x = await boot();
  assert.equal(x.calls.length, 1); assert.equal(x.calls[0].command, 'get_ui_state');
  assert.match(x.host.textContent, /Наличие расширения неизвестно/);
  assert.match(x.host.textContent, /защита не проверена/);
  assert.equal(x.dispose.isDirty(), false);
});

test('exact fields survive save, readback and reopening, with export separated from writes', async () => {
  const x = await boot(); x.edit(example());
  assert.equal(x.dispose.isDirty(), true); assert.equal(x.action('export').disabled, true);
  x.action('save').click(); await tick();
  assert.deepEqual(JSON.parse(x.raw()), example());
  assert.equal(x.dispose.isDirty(), false); assert.equal(x.pending.at(-1), false);
  assert.match(x.q('[role="status"]').textContent, /Сохранено и перечитано/);
  const y = await boot(x.raw());
  assert.equal(y.q('[data-focus-field="exceptions"]').value, example().exceptions);
  y.action('export').click();
  assert.equal(y.calls.length, 1);
  const text = y.q('pre').textContent;
  assert.match(text, /\+chat.example.com\n\+mail.example.com/);
  assert.match(text, /0900-1200,1300-1700/); assert.match(text, /Пн, Вт, Ср, Чт, Пт/);
  assert.match(text, /НЕ файл Import Options/); assert.match(text, /Отмена:/);
  assert.match(text, /Не заменяй другие наборы/);
  assert.equal(decodeURIComponent(y.q('a').getAttribute('href').split(',')[1]), text);
  y.edit({...example(), sites: 'different.example.com'});
  assert.equal(y.q('a').hidden, true); assert.equal(y.action('export').disabled, true);
});

test('unsupported platform can retain its draft without advertising export or active enforcement', async () => {
  const x = await boot(JSON.stringify(example())); x.edit({...example(), platform: 'unsupported'});
  x.action('save').click(); await tick();
  assert.equal(JSON.parse(x.raw()).platform, 'unsupported');
  assert.equal(x.action('export').disabled, true);
  const y = await boot(x.raw()); assert.match(y.q('[role="status"]').textContent, /не поддерживается/);
  assert.throws(() => focusRecipe({...example(), platform: 'unsupported'}));
});

test('invalid and incomplete recipes cannot be exported, draft saving invents no schedule', async () => {
  const x = await boot(); x.action('save').click(); await tick();
  assert.deepEqual(JSON.parse(x.raw()), emptyFocusConfig());
  x.action('export').click(); assert.match(x.q('[role="status"]').textContent, /Укажи сайты/);
  for (const patch of [{sites: 'https://example.com'}, {sites: '*'}, {exceptions: '+chat.example.com'}, {times: '2300-0600'}, {times: '0900-2460'}, {times: '1260-1400'}, {days: [2, 1]}, {days: [1, 1]}]) assert.throws(() => validateFocusConfig({...example(), ...patch}));
  validateFocusConfig({...example(), times: '0000-0600,2300-2400'});
  x.edit({...example(), sites: '<script>alert(1)</script>'}); x.action('save').click(); await tick();
  assert.deepEqual(JSON.parse(x.raw()), emptyFocusConfig());
});

test('load failure or unknown schema locks save, retry restores availability without overwriting', async () => {
  for (const initial of ['{bad', JSON.stringify({...example(), version: 2})]) {
    const x = await boot(initial); assert.equal(x.action('save').disabled, true);
    assert.equal(x.calls.length, 1); x.remote(JSON.stringify(example())); x.action('reload').click(); await tick();
    assert.equal(x.action('save').disabled, false); assert.equal(x.calls.length, 2);
  }
  const x = await boot('', {read: true}); x.fail.read = false; x.action('reload').click(); await tick();
  assert.equal(x.action('save').disabled, false);
});

test('concurrent update and uncertain write preserve draft, require read before another write', async () => {
  const x = await boot(JSON.stringify(example())); x.edit({...example(), times: '1800-1900'});
  const remote = JSON.stringify({...example(), times: '0700-0800'}); x.remote(remote);
  x.action('save').click(); await tick();
  assert.equal(x.raw(), remote); assert.equal(x.action('save').disabled, true); assert.equal(x.dispose.isDirty(), true);
  x.action('reload').click(); assert.equal(x.action('discard').hidden, false);
  assert.equal(x.q('[data-focus-field="times"]').value, '1800-1900');
  x.action('discard').click(); await tick(); assert.equal(x.q('[data-focus-field="times"]').value, '0700-0800');
  const y = await boot('', {afterWrite: true}); y.edit(example()); y.action('save').click(); await tick();
  assert.equal(y.action('save').disabled, true); assert.equal(y.dispose.isDirty(), true);
  y.fail.read = false; y.action('reload').click(); y.action('discard').click(); await tick();
  assert.equal(y.dispose.isDirty(), false); assert.deepEqual(JSON.parse(y.raw()), example());
  assert.equal(y.calls.filter(c => c.command === 'set_ui_state').length, 1);
});

test('discard failure keeps draft and baseline, disposal ignores a late read', async () => {
  const x = await boot(JSON.stringify(example())); x.edit({...example(), times: '1800-1900'}); x.fail.read = true;
  x.action('reload').click(); x.action('discard').click(); await tick();
  assert.equal(x.q('[data-focus-field="times"]').value, '1800-1900'); assert.equal(x.dispose.isDirty(), true);
  const dom = new JSDOM('<section></section>'); let resolve;
  const dispose = mountFocusAdapterSettings(dom.window.document.querySelector('section'), {invoke: () => new Promise(yes => {resolve = yes;})});
  dispose(); resolve(JSON.stringify(example())); await tick();
  assert.equal(dom.window.document.querySelector('[data-focus-action="save"]').disabled, true);
});

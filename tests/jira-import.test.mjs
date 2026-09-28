// Titles-only Jira settings and periodic import. Fictional data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { jiraErrorText, jiraStatusText, mountJiraSettings, startJiraImport } from '../src/hanni/js/jira-import.js';

const settle = async (rounds = 6) => { for (let i = 0; i < rounds; i++) await new Promise(resolve => setImmediate(resolve)); };
const SITE = 'example.atlassian.net';
const TOKEN = 'fictional-api-token-value';
const idle = (extra = {}) => ({ supported: true, enabled: false, site: '', project: '', email: '', tokenMode: 'scoped', tokenSaved: false, lastAttempt: null, lastSuccess: null, lastCount: null, lastError: null, nextAttempt: null, truncated: false, running: false, changed: 0, ...extra });
const connected = (extra = {}) => idle({ enabled: true, site: SITE, project: 'DEMO', email: 'demo@example.com', tokenSaved: true, ...extra });

function mount(t, handler = () => idle()) {
  const dom = new JSDOM('<form><section id="host"></section></form>', { url: 'https://fixture.invalid', pretendToBeVisual: true });
  const host = dom.window.document.querySelector('#host'), calls = [], pending = [];
  const invoke = async (command, args) => { calls.push({ command, args }); return handler(command, args); };
  const dispose = mountJiraSettings(host, { invoke, setPending: value => pending.push(value) });
  t.after(() => { dispose(); dom.window.close(); });
  const q = name => host.querySelector(`[data-jira-${name}]`);
  const type = (name, value) => { q(name).value = value; q(name).dispatchEvent(new dom.window.Event('input', { bubbles: true })); };
  return { dom, host, calls, pending, dispose, q, type, commands: () => calls.map(call => call.command) };
}

test('the section explains the allowed fields, explicit writes and token scopes', async t => {
  const x = mount(t); await settle();
  assert.equal(x.host.querySelector('h3').textContent, 'Jira');
  assert.match(x.host.textContent, /Сохраняются названия и статусы: без описаний, комментариев, вложений, ключей и ссылок Jira/);
  assert.match(x.host.textContent, /Если включена синхронизация Cicada/);
  assert.match(x.host.textContent, /Загружаются все задачи выбранного проекта, включая завершённые/);
  assert.match(x.host.textContent, /id\.atlassian\.com → Security → API tokens/);
  assert.match(x.host.textContent, /Подключай Jira только на одном компьютере — иначе переименования из Jira попадут в разбор версий\./);
  assert.deepEqual([...x.host.querySelectorAll('label')].map(label => label.firstChild.textContent), ['Сайт Jira', 'Ключ проекта', 'Email', 'Тип API-токена', 'API-токен']);
  assert.equal(x.q('token').type, 'password');
  assert.deepEqual([...x.host.querySelectorAll('button')].map(button => button.textContent), ['Сохранить и подключить', 'Загрузить сейчас', 'Отключить']);
  assert.match(x.q('status').textContent, /не подключена/);
  assert.equal(x.q('now').disabled, true); assert.equal(x.q('disable').disabled, true); assert.equal(x.q('save').disabled, false);
  assert.deepEqual(x.commands(), ['jira_import_status']);
  assert.deepEqual(x.pending, [], 'the initial lookup does not lock the dialog');
});

test('Save stores the connection, clears the token and checks it with an import', async t => {
  let status = idle();
  const x = mount(t, command => {
    if (command === 'jira_import_configure') return (status = connected());
    if (command === 'jira_import_now') return (status = connected({ lastSuccess: '2026-09-25T09:00:00.000Z', lastCount: 3, changed: 3 }));
    return status;
  });
  await settle();
  let imported = 0; x.dom.window.addEventListener('hanni:jira-imported', () => imported++);
  x.type('site', ' https://example.atlassian.net/ '); x.type('email', 'demo@example.com'); x.type('token', TOKEN); x.type('project', 'demo');
  x.q('save').click(); await settle();
  assert.deepEqual(x.commands(), ['jira_import_status', 'jira_import_configure', 'jira_import_now']);
  assert.deepEqual(x.calls[1].args, { site: 'https://example.atlassian.net/', project: 'demo', email: 'demo@example.com', token: TOKEN, tokenMode: 'scoped' });
  assert.equal(x.q('token').value, '');
  assert.doesNotMatch(x.host.innerHTML, new RegExp(TOKEN));
  assert.equal(x.q('site').value, SITE, 'the stored, normalized values replace the draft');
  assert.equal(x.q('project').value, 'DEMO');
  assert.match(x.q('status').textContent, /Последняя загрузка: .* · задач: 3\./);
  assert.match(x.q('token').placeholder, /оставь пустым/);
  assert.equal(imported, 1, 'new tasks ask for a refresh and a sync');
  assert.deepEqual(x.pending, [true, false]);
  assert.equal(x.q('error').hidden, true);
  assert.equal(x.dispose.isDirty(), false);
});

test('a late initial status or error cannot overwrite a newer connected state', async t => {
  for (const rejected of [false, true]) {
    let finish;
    const x = mount(t, () => new Promise((resolve, reject) => { finish = rejected ? reject : resolve; }));
    await settle();
    x.dom.window.dispatchEvent(new x.dom.window.CustomEvent('hanni:jira-status', { detail: connected() }));
    finish(rejected ? new Error('old failure') : idle());
    await settle();
    assert.equal(x.q('project').value, 'DEMO');
    assert.equal(x.q('now').disabled, false);
    assert.equal(x.q('error').hidden, true);
  }
});

test('a saved token with rejected scopes is not presented as a working connection', async t => {
  const x = mount(t, command => command === 'jira_import_status' ? idle() : connected({ lastError: command === 'jira_import_now' ? 'jira_scope_missing' : null }));
  await settle();
  x.type('site', SITE); x.type('email', 'demo@example.com'); x.type('project', 'DEMO'); x.type('token', TOKEN);
  x.q('save').click(); await settle();
  assert.match(x.q('status').textContent, /Токен сохранён, но подключиться к Jira не удалось/);
  assert.match(x.q('error').textContent, /read:jira-work и write:jira-work типа Classic/);
  assert.equal(x.q('token').value, '');
  assert.match(x.q('token').placeholder, /Сохранён/);
  assert.deepEqual([...x.q('scopes').querySelectorAll('code')].map(code => code.textContent), ['read:jira-work', 'write:jira-work']);
  assert.equal(x.dispose.isDirty(), false);
});

test('an inaccessible old token can be replaced in the settings; failed storage keeps the new draft', async t => {
  let writeFails = true;
  const x = mount(t, command => {
    if (command === 'jira_import_status') return connected({ tokenSaved: false, lastError: 'jira_token_unavailable' });
    if (command === 'jira_import_configure' && writeFails) throw 'jira_token_write_failed';
    return connected({ lastSuccess: '2026-09-25T09:00:00Z', lastCount: 2 });
  });
  await settle();
  assert.match(x.q('status').textContent, /нужен API-токен/);
  x.type('token', TOKEN); x.q('save').click(); await settle();
  assert.equal(x.q('token').value, TOKEN);
  assert.match(x.q('error').textContent, /Не удалось сохранить новый токен/);
  assert.equal(x.dispose.isDirty(), true);
  assert.deepEqual(x.commands(), ['jira_import_status', 'jira_import_configure']);
  writeFails = false;
  x.q('save').click(); await settle();
  assert.equal(x.calls[2].args.token, TOKEN);
  assert.equal(x.q('token').value, '');
  assert.equal(x.q('error').hidden, true);
  assert.match(x.q('status').textContent, /задач: 2/);
});

test('a scoped token is the default; changing its type sends an explicit native choice', async t => {
  const x = mount(t, command => command === 'jira_import_status' ? idle() : connected({ tokenMode: 'classic' }));
  await settle();
  assert.equal(x.q('token-mode').value, 'scoped');
  x.type('site', SITE); x.type('email', 'demo@example.com'); x.type('project', 'DEMO'); x.type('token', TOKEN);
  x.q('token-mode').value = 'classic';
  x.q('token-mode').dispatchEvent(new x.dom.window.Event('change', { bubbles: true }));
  x.q('save').click(); await settle();
  assert.equal(x.calls[1].args.tokenMode, 'classic');
  assert.equal(x.q('token-mode').value, 'classic');
});

test('a draft survives background status; disposal clears the password and raw errors stay hidden', async t => {
  const secretError = `server response contains ${TOKEN} and a private description`;
  const x = mount(t, command => { if (command === 'jira_import_status') return connected(); throw new Error(secretError); });
  await settle();
  x.type('project', 'OTHER'); x.type('token', TOKEN);
  assert.equal(x.dispose.isDirty(), true);
  x.dom.window.dispatchEvent(new x.dom.window.CustomEvent('hanni:jira-status', { detail: connected() }));
  assert.equal(x.q('project').value, 'OTHER');
  x.q('save').click(); await settle();
  assert.equal(x.q('error').textContent, jiraErrorText('unknown'));
  assert.doesNotMatch(x.host.textContent, /private description|fictional-api-token-value/);
  assert.equal(x.dispose.isDirty(), true);
  x.dispose();
  assert.equal(x.q('token').value, '');
});

test('a running import blocks Save and Enter until it finishes', async t => {
  const x = mount(t, () => connected({ running: true }));
  await settle();
  x.type('project', 'OTHER');
  assert.equal(x.q('save').disabled, true);
  x.q('project').dispatchEvent(new x.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await settle();
  assert.deepEqual(x.commands(), ['jira_import_status']);
});

test('an empty token keeps the saved one and missing fields are explained without a request', async t => {
  const x = mount(t, command => command === 'jira_import_status' ? idle() : connected());
  await settle();
  x.type('site', SITE); x.q('save').click(); await settle();
  assert.match(x.q('error').textContent, /Заполни сайт, email и ключ проекта/);
  x.type('email', 'demo@example.com'); x.type('project', 'DEMO'); x.q('save').click(); await settle();
  assert.equal(x.q('error').textContent, 'Введи API-токен.');
  assert.deepEqual(x.commands(), ['jira_import_status']);
  const saved = mount(t, command => connected({ changed: 0 }));
  await settle();
  assert.equal(saved.q('email').value, 'demo@example.com');
  saved.q('save').click(); await settle();
  assert.equal(saved.calls[1].command, 'jira_import_configure');
  assert.equal(saved.calls[1].args.token, null);
});

test('errors are shown in Russian, including a token that has to be entered again', async t => {
  const x = mount(t, () => connected({ lastError: 'jira_token_unavailable' }));
  await settle();
  assert.equal(x.q('error').hidden, false);
  assert.match(x.q('error').textContent, /Сохранённый API-токен недоступен.*Вставь новый токен/);
  for (const code of ['jira_unauthorized', 'jira_forbidden', 'jira_not_found', 'jira_rate_limited', 'jira_network_unavailable', 'jira_bad_request']) assert.notEqual(jiraErrorText(code), jiraErrorText('unknown'), code);
  assert.match(jiraErrorText('jira_unauthorized'), /email, API-токен/);
  assert.match(jiraErrorText('jira_scope_missing'), /несовпадении прав токена и запроса.*scopes/);
  assert.match(jiraErrorText('jira_scope_missing'), /read:jira-work/);
  assert.equal(jiraErrorText('jira_token_required_for_site'), 'При смене сайта или типа токена введи API-токен заново.');
  const failing = mount(t, command => { if (command === 'jira_import_status') return idle(); throw 'jira_site_invalid'; });
  await settle();
  failing.type('site', 'not a site'); failing.type('email', 'demo@example.com'); failing.type('token', TOKEN); failing.type('project', 'DEMO');
  failing.q('save').click(); await settle();
  assert.match(failing.q('error').textContent, /example\.atlassian\.net/);
  assert.equal(failing.q('token').value, TOKEN, 'a rejected save keeps the draft for correction');
  // Another site with the token field left empty: the native side refuses to reuse the saved token.
  const moved = mount(t, command => { if (command === 'jira_import_status') return connected(); throw 'jira_token_required_for_site'; });
  await settle();
  moved.type('site', 'other.atlassian.net'); moved.q('save').click(); await settle();
  assert.deepEqual(moved.calls[1], { command: 'jira_import_configure', args: { site: 'other.atlassian.net', project: 'DEMO', email: 'demo@example.com', token: null, tokenMode: 'scoped' } });
  assert.equal(moved.q('error').textContent, 'При смене сайта или типа токена введи API-токен заново.');
  assert.deepEqual(moved.commands(), ['jira_import_status', 'jira_import_configure'], 'no import after a refused save');
  assert.equal(jiraStatusText(connected({ lastSuccess: '2026-09-25T09:00:00Z', lastCount: 500, truncated: true })).includes('первые 500'), true);
});

test('Enter saves the section instead of submitting the settings dialog', async t => {
  const x = mount(t, command => command === 'jira_import_status' ? idle() : connected());
  await settle();
  x.type('site', SITE); x.type('email', 'demo@example.com'); x.type('token', TOKEN); x.type('project', 'DEMO');
  let submitted = 0; x.dom.window.document.querySelector('form').addEventListener('submit', () => submitted++);
  const event = new x.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  x.q('project').dispatchEvent(event); await settle();
  assert.equal(event.defaultPrevented, true);
  assert.equal(submitted, 0);
  assert.equal(x.calls[1].command, 'jira_import_configure');
});

test('Import now and Disable use their own commands; the phone shows why the import is unavailable', async t => {
  const x = mount(t, command => command === 'jira_import_disable' ? idle({ site: SITE, project: 'DEMO' }) : connected());
  await settle();
  x.q('now').click(); await settle();
  x.q('disable').click(); await settle();
  assert.deepEqual(x.commands(), ['jira_import_status', 'jira_import_now', 'jira_import_disable']);
  assert.match(x.q('status').textContent, /не подключена. Уже загруженные задачи остаются/);
  assert.equal(x.q('email').value, '');
  const phone = mount(t, () => ({ supported: false }));
  await settle();
  assert.equal(phone.q('form').hidden, true);
  assert.equal(phone.q('unsupported').hidden, false);
  assert.match(phone.q('unsupported').textContent, /На телефоне импорт недоступен/);
});

test('the periodic check ticks while visible and asks for a refresh and a sync only after a change', async t => {
  const dom = new JSDOM('', { url: 'https://fixture.invalid', pretendToBeVisual: true });
  const { window } = dom, calls = [];
  let changed = 2, syncs = 0, refreshes = 0, intervals = 0;
  const realSetInterval = window.setInterval.bind(window);
  window.setInterval = (fn, ms) => { intervals++; assert.equal(ms, 60_000); return realSetInterval(fn, ms); };
  const dispose = startJiraImport({ window, invoke: async command => { calls.push(command); return connected({ changed }); }, requestSync: () => syncs++, requestRefresh: () => refreshes++ });
  t.after(() => { dispose(); dom.window.close(); });
  await settle();
  assert.deepEqual(calls, ['jira_import_tick']);
  assert.equal(intervals, 1);
  assert.deepEqual([syncs, refreshes], [1, 1]);
  changed = 0; window.dispatchEvent(new window.Event('focus')); await settle();
  assert.deepEqual(calls, ['jira_import_tick', 'jira_import_tick']);
  assert.deepEqual([syncs, refreshes], [1, 1]);
  Object.defineProperty(window.document, 'visibilityState', { value: 'hidden', configurable: true });
  window.dispatchEvent(new window.Event('focus')); await settle();
  assert.equal(calls.length, 2, 'a hidden window does not import');
});

test('the periodic check stops on the phone and survives a failing command', async t => {
  const dom = new JSDOM('', { url: 'https://fixture.invalid', pretendToBeVisual: true });
  const { window } = dom, calls = [];
  let answer = () => { throw new Error('down'); };
  const dispose = startJiraImport({ window, invoke: async command => { calls.push(command); return answer(); }, requestSync() {}, requestRefresh() {} });
  t.after(() => { dispose(); dom.window.close(); });
  await settle();
  answer = () => ({ supported: false });
  window.dispatchEvent(new window.Event('focus')); await settle();
  window.dispatchEvent(new window.Event('focus')); await settle();
  assert.equal(calls.length, 2, 'unsupported stops the check');
});

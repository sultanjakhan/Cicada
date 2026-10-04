import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountThemeControl, placeThemeControlNextToToday } from '../src/hanni/js/theme-control.js';
import { mountAppUpdates } from '../src/hanni/js/app-updates.js';
import { mountDataSources } from '../src/hanni/js/data-sources.js';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('home theme control restores device choice, toggles both ways and tracks settings changes', () => {
  const dom = new JSDOM('<html lang="ru"><header></header></html>', { url:'https://cicada.test' });
  const { window } = dom, host = window.document.querySelector('header');
  window.localStorage.setItem('hanni_theme', 'dark');
  const getTheme = () => window.localStorage.getItem('hanni_theme');
  const setTheme = theme => { window.localStorage.setItem('hanni_theme', theme); window.dispatchEvent(new window.Event('hanni:theme-changed')); };
  const stop = mountThemeControl(host, { getTheme, setTheme });
  const button = host.querySelector('button');
  assert.equal(button.type, 'button'); assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.equal(button.getAttribute('aria-label'), 'Включить светлую тему');
  button.click(); assert.equal(getTheme(), 'light'); assert.equal(button.getAttribute('aria-pressed'), 'false');
  button.click(); assert.equal(getTheme(), 'dark');
  setTheme('light'); assert.equal(button.getAttribute('aria-pressed'), 'false');
  assert.equal(button.querySelector('svg').getAttribute('aria-hidden'), 'true');
  stop(); assert.equal(host.children.length, 0); dom.window.close();
});

test('unconfigured update channel does not offer install or promise automatic updates', async () => {
  const dom = new JSDOM('<section></section>'), host = dom.window.document.querySelector('section');
  const stop = mountAppUpdates(host, { invoke: async () => ({ configured:false, phase:'available', version:'0.5.0', installed_version:'0.4.4' }) });
  await tick();
  assert.equal(host.querySelector('[data-update-check]').disabled, true);
  assert.match(host.querySelector('[data-update-hint]').textContent, /Автоматическая проверка и установка недоступны/);
  assert.equal(host.querySelector('[data-update-install]').hidden, true);
  dom.window.dispatchEvent(new dom.window.CustomEvent('hanni:update-status', { detail:{ configured:true, phase:'available', version:'0.5.0' } }));
  assert.equal(host.querySelector('[data-update-check]').disabled, false);
  assert.equal(host.querySelector('[data-update-install]').hidden, false);
  stop(); dom.window.close();
});

test('connection fields group actions and keep checkbox labels associated without writes', async () => {
  const dom = new JSDOM('<section></section>'), host = dom.window.document.querySelector('section'), calls=[];
  const stop = mountDataSources(host, { invoke: async command => { calls.push(command); return null; } });
  await tick();
  assert.equal(host.querySelectorAll('.data-source-setting').length, 2);
  for (const section of host.querySelectorAll('.data-source-setting')) {
    assert.equal(section.querySelector('.calendar-sync-actions').querySelectorAll('button').length, 2);
    for (const checkbox of section.querySelectorAll('input[type="checkbox"]')) assert.ok(checkbox.closest('label.calendar-settings-toggle'));
    assert.ok(section.querySelector('.data-source-field input[type="text"]'));
  }
  assert.deepEqual(calls, ['get_ui_state']); stop(); dom.window.close();
});

test('theme stays immediately after upper Today control, outside Today body, preserving saved preference and handlers',()=>{
 const dom=new JSDOM('<html lang="ru"><header><div data-calendar-today-controls><div data-calendar-running><button data-header-action="in-progress">Сегодня</button></div></div></header><section class="calendar-today"><div class="calendar-day-banner"></div></section></html>',{url:'https://fixture.test'}),doc=dom.window.document;dom.window.localStorage.setItem('hanni_theme','dark');const getTheme=()=>dom.window.localStorage.getItem('hanni_theme'),setTheme=value=>{dom.window.localStorage.setItem('hanni_theme',value);};const stop=mountThemeControl(doc.querySelector('header'),{getTheme,setTheme}),button=doc.querySelector('[data-home-theme]'),today=doc.querySelector('[data-calendar-running]');placeThemeControlNextToToday(doc,today);assert.equal(today.nextElementSibling,button);assert.equal(button.closest('.calendar-today'),null);assert.equal(doc.querySelectorAll('[data-home-theme]').length,1);assert.equal(button.getAttribute('aria-pressed'),'true');assert.ok(button.getAttribute('aria-label'));assert.equal(getTheme(),'dark');button.click();assert.equal(getTheme(),'light');stop();assert.equal(doc.querySelector('[data-home-theme]'),null);dom.window.close();
});

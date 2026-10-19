import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';
import {mountThemeControl} from '../src/hanni/js/theme-control.js';

test('pane replacement retains focus on the selected Tasks/Routines button and preserves all six panes',async()=>{
  const dom=new JSDOM('<main></main>',{url:'https://fixture.invalid',pretendToBeVisual:true}),d=dom.window.document,host=d.querySelector('main');
  const source=fs.readFileSync(new URL('../src/hanni/js/unified-layout.js',import.meta.url),'utf8').replace(/^\uFEFF/,'').replace(/^import .*;\r?\n/gm,'').replace(/export /g,'');
  const state={theme:'light'};
  const setTheme=theme=>{state.theme=theme;dom.window.localStorage.setItem('hanni_theme',theme);dom.window.dispatchEvent(new dom.window.Event('hanni:theme-changed'));};
  const render=new Function('S','invoke','TAB_ICONS','escapeHtml','document','window','localStorage','mountThemeControl','setTheme','IS_MOBILE',source+'\nreturn renderUnifiedLayout;')(state,async()=>null,{},x=>x,d,dom.window,dom.window.localStorage,mountThemeControl,setTheme,false);
  const panes=['dash','table','tasks','routines','notes','goals'].map(id=>({id,label:id}));
  const config={panes,editableHeader:false,renderTasks:p=>{p.textContent='tasks';},renderRoutines:p=>{p.textContent='routines';}};
  await render(host,'calendar',config);
  host.querySelector('[data-home-theme]').click();
  assert.equal(dom.window.localStorage.getItem('hanni_theme'),'dark');
  for(const id of ['tasks','routines','tasks']){
    const button=host.querySelector(`[data-pane="${id}"]`);button.focus();button.click();
    for(let i=0;i<3;i++)await new Promise(resolve=>setImmediate(resolve));
    assert.equal(d.activeElement,host.querySelector(`[data-pane="${id}"]`));
    assert.equal(d.activeElement.getAttribute('aria-pressed'),'true');
    assert.equal(host.querySelectorAll('.uni-tab').length,6);
    assert.equal(host.querySelector('.uni-pane').textContent,id);
    assert.equal(host.querySelectorAll('[data-home-theme]').length,1);
    assert.equal(host.querySelector('[data-home-theme]').getAttribute('aria-pressed'),'true');
  }
  dom.window.close();
});

test('Dashboard Today control and every other pane fallback remain exclusive through remounts',async()=>{
 const {mountCalendarDayBanner}=await import('../src/hanni/js/calendar-day-banner.js');
 for(const mobile of [false,true]){
  const dom=new JSDOM('<div id="mobile-header"></div><main></main>',{url:'https://fixture.invalid',pretendToBeVisual:true}),d=dom.window.document,host=d.querySelector('main');
  const source=fs.readFileSync(new URL('../src/hanni/js/unified-layout.js',import.meta.url),'utf8').replace(/^\uFEFF/,'').replace(/^import .*;\r?\n/gm,'').replace(/export /g,'');
  const state={theme:'light'},setTheme=value=>{state.theme=value;dom.window.localStorage.setItem('hanni_theme',value);dom.window.dispatchEvent(new dom.window.Event('hanni:theme-changed'));};
  const render=new Function('S','invoke','TAB_ICONS','escapeHtml','document','window','localStorage','mountThemeControl','setTheme','IS_MOBILE',source+'\nreturn renderUnifiedLayout;')(state,async()=>null,{},x=>x,d,dom.window,dom.window.localStorage,mountThemeControl,setTheme,mobile);
  let dispose;const config={themeInToday:true,beforeRender:()=>{dispose?.();dispose=null;},panes:['dash','tasks','goals','routines','notes','table'].map(id=>({id,label:id})),renderDash:p=>{dispose=mountCalendarDayBanner(p,{invoke:async()=>null,theme:{getTheme:()=>state.theme,setTheme}});}};
  for(const id of ['dash','tasks','goals','routines','notes','table','dash','tasks','dash']){
   state._unifiedPane={calendar:id};await render(host,'calendar',config);
   const buttons=d.querySelectorAll('[data-home-theme]');assert.equal(buttons.length,1,`${mobile} ${id}`);
   const button=buttons[0];assert.equal(button.parentElement,id==='dash'?host.querySelector('.today-date'):mobile?d.querySelector('#mobile-header'):host.querySelector('.uni-header'));
   button.focus();assert.equal(d.activeElement,button);button.click();assert.equal(button.getAttribute('aria-pressed'),String(state.theme==='dark'));assert.equal(dom.window.localStorage.getItem('hanni_theme'),state.theme);
  }
  dispose?.();dom.window.close();
 }
});

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

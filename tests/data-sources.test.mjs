import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultDataSources,validateDataSources,mountDataSources,DATA_SOURCES_KEY} from '../src/hanni/js/data-sources.js';
import {JSDOM} from 'jsdom';
test('source preferences accept absolute local paths but reject unsupported security/config fields',()=>{
  const s=defaultDataSources();s.sources[0].path='C:\\synthetic\\cicada-data';assert.equal(validateDataSources(s),s);
  for(const change of [s=>s.sources[0].path='../data',s=>s.sources[0].credentials='secret',s=>s.sources[1].appId='cicada',s=>s.refresh.mode='auto',s=>s.sources[0].placement='architecture']){const bad=defaultDataSources();change(bad);assert.throws(()=>validateDataSources(bad));}
});
test('new source path requires preview, save revalidates, chooser cancel preserves draft',async()=>{
  const dom=new JSDOM('<body><main></main>'),host=dom.window.document.querySelector('main');let raw='',inspections=0,writes=0;
  const invoke=async(cmd,args)=>{if(cmd==='get_ui_state')return raw;if(cmd==='choose_data_source')return null;if(cmd==='inspect_data_source'){inspections++;return {inspectedAt:'2026-10-02T09:00:00Z',entries:[{name:'tasks',exists:true}]};}assert.equal(cmd,'set_ui_state');assert.equal(args.key,DATA_SOURCES_KEY);assert.equal(args.expectedValue,raw);raw=args.value;writes++;};
  const stop=mountDataSources(host,{invoke}),tick=()=>new Promise(r=>setTimeout(r,0));await tick();
  const input=host.querySelector('input[type=text]');input.value='C:\\synthetic\\cicada-data';input.dispatchEvent(new dom.window.Event('input'));
  const button=text=>[...host.querySelectorAll('button')].find(b=>b.textContent===text);
  button('Сохранить источники').click();await tick();assert.equal(writes,0);
  button('Выбрать папку cicada').click();await tick();assert.equal(input.value,'C:\\synthetic\\cicada-data');assert.equal(inspections,0);
  button('Проверить папку cicada').click();await tick();button('Сохранить источники').click();await tick();assert.equal(writes,1);assert.equal(inspections,2);assert.equal(JSON.parse(raw).sources[0].path,input.value);stop();
});

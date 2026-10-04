import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {mountRegistrySources} from '../src/hanni/js/work-registry-tasks.js';
import {defaultDataSources,DATA_SOURCES_KEY,mountSourceOnboarding} from '../src/hanni/js/data-sources.js';
import {REGISTRY_KEY,validateRegistry} from '../src/hanni/js/work-registry.js';
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const snapshot=validateRegistry(await readFile(new URL('../scripts/fixtures/uki-engineering-20261002.json',import.meta.url),'utf8'));
function environment(initial={}){const dom=new JSDOM('<body><main></main>',{url:'http://localhost'});const values=new Map(Object.entries(initial));const invoke=async(cmd,a)=>{if(cmd==='get_ui_state')return values.get(a.key)??'';if(cmd==='set_ui_state'){assert.equal(a.expectedValue,values.get(a.key)??'');values.set(a.key,a.value);return;}throw Error(cmd);};return {dom,host:dom.window.document.querySelector('main'),invoke,values};}
test('published unbound hierarchy appears in tasks and visibility/placement take effect',async()=>{
 const config=defaultDataSources();config.sources[1].visible=false;const env=environment({[DATA_SOURCES_KEY]:JSON.stringify(config),[REGISTRY_KEY]:JSON.stringify({'uki-engineering:01a0f1a5-4bd0-705a-ae10-24cf6adf30fc':snapshot})});
 const stop=mountRegistrySources(env.host,{invoke:env.invoke,onSettings:()=>{}});await tick();
 assert.match(env.host.textContent,/Улучшение Agent City и Цикады/);assert.equal(env.host.querySelectorAll('li').length,9);assert.match(env.host.textContent,/Не live/);assert.match(env.host.textContent,/Сводка Üki/);
 config.sources[0].placement='tasks';env.values.set(DATA_SOURCES_KEY,JSON.stringify(config));env.dom.window.dispatchEvent(new env.dom.window.Event('hanni:data-sources-changed'));await tick();
 const tasks=[...env.host.querySelectorAll('section')].find(x=>x.firstElementChild.textContent.startsWith('Tasks'));assert.equal(tasks.hidden,false);assert.match(tasks.textContent,/Улучшение Agent City/);assert.doesNotMatch(env.host.textContent,/Architecture/);
 config.sources[0].visible=false;env.values.set(DATA_SOURCES_KEY,JSON.stringify(config));env.dom.window.dispatchEvent(new env.dom.window.Event('hanni:data-sources-changed'));await tick();assert.doesNotMatch(env.host.textContent,/Улучшение Agent City/);stop();
});
test('new-profile skip persists and never repeats; existing unconfigured profile is not prompted',async()=>{
 const old=environment();mountSourceOnboarding(old.host,{invoke:old.invoke,onSettings:()=>{}});await tick();assert.equal(old.host.querySelector('button'),null);
 const env=environment({'cicada_sources_onboarding_eligible_v1':'true'});mountSourceOnboarding(env.host,{invoke:env.invoke,onSettings:()=>{}});await tick();const skip=[...env.host.querySelectorAll('button')].find(x=>x.textContent==='Пропустить');assert.ok(skip);skip.click();await tick();assert.equal(env.host.querySelector('button'),null);
 mountSourceOnboarding(env.host,{invoke:env.invoke,onSettings:()=>{}});await tick();assert.equal(env.host.querySelector('button'),null);assert.equal(JSON.parse(env.values.get(DATA_SOURCES_KEY)).onboarding.status,'skipped');
});

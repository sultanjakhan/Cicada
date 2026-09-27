import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {mountCalendarRoutineChoices} from '../src/hanni/js/calendar-routine-choices.js';
const tick=async()=>{for(let i=0;i<6;i++)await new Promise(resolve=>setImmediate(resolve));};
async function boot(t){
  const dom=new JSDOM('<main></main>');const host=dom.window.document.querySelector('main');
  const date='2026-09-27';let state={version:1,plans:[['check','Отметка','check'],['chain','Два шага','chain'],['graph','Ветвящаяся рутина','graph']].map(([id,title,mode])=>({id,title,kind:'action',mode,steps:mode==='chain'?[{title:'Один'},{title:'Два'}]:mode==='graph'?[{title:'Корень',dependsOn:[]},{title:'Ветка',dependsOn:[0]}]:[],active:true,required:true,createdOn:date,startsOn:'',endsOn:'',time:'',weekdays:[0,1,2,3,4,5,6]})),days:{}};
  const writes=[],opened=[];const invoke=async(name,args)=>{if(name==='get_ui_state')return JSON.stringify(state);if(name==='set_ui_state'){writes.push(args);assert.equal(args.expectedValue,JSON.stringify(state));state=JSON.parse(args.value);return;}throw Error(name);};
  const dispose=mountCalendarRoutineChoices(host,{invoke,now:()=>new Date(date+'T12:00:00'),openRoutine:value=>opened.push(value)});t.after(()=>{dispose();dom.window.close();});await tick();
  return{dom,host,writes,opened,state:()=>state,choose:id=>host.querySelector(`[data-routine-choice="${id}"]`).click()};
}
test('check routines mark canonically once; chains only open their owner runner',async t=>{const x=await boot(t);x.choose('check');x.choose('check');await tick();assert.equal(x.writes.length,1);assert.equal(x.state().days['2026-09-27'].check.status,'done');assert.equal(x.host.querySelector('[data-routine-choice="check"]'),null);x.choose('chain');await tick();assert.deepEqual(x.opened,[{id:'chain',date:'2026-09-27',start:true}]);assert.equal(x.writes.length,1);});
test('remote completion between rendering and click cannot be overwritten',async t=>{const x=await boot(t);x.state().days['2026-09-27']={check:{snapshot:x.state().plans[0],status:'done'}};x.choose('check');await tick();assert.equal(x.writes.length,0);assert.match(x.host.querySelector('[role="alert"]').textContent,/уже отмечена/);});
test('graph routine stays on the shared Start list and only opens execution after an explicit click',async t=>{const x=await boot(t);const button=x.host.querySelector('[data-routine-choice="graph"]');assert.match(button.parentElement.textContent,/2 связанных шагов/);button.click();await tick();assert.deepEqual(x.opened,[{id:'graph',date:'2026-09-27',start:true}]);assert.equal(x.writes.length,0);});
test('routine no-op refresh retains focused action DOM',async t=>{const x=await boot(t);const button=x.host.querySelector('[data-routine-choice="chain"]');button.focus();x.dom.window.dispatchEvent(new x.dom.window.Event('hanni:calendar-refresh'));await tick();assert.equal(x.host.querySelector('[data-routine-choice="chain"]'),button);assert.equal(x.dom.window.document.activeElement,button);});

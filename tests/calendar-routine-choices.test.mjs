import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {mountCalendarRoutineChoices} from '../src/hanni/js/calendar-routine-choices.js';
const tick=async()=>{for(let i=0;i<6;i++)await new Promise(resolve=>setImmediate(resolve));};
async function boot(t){
  const dom=new JSDOM('<main></main>');const host=dom.window.document.querySelector('main');
  const date='2026-09-27';let state={version:1,plans:[['check','Отметка','check'],['chain','Два шага','chain'],['graph','Ветвящаяся рутина','graph']].map(([id,title,mode])=>({id,title,kind:'action',mode,steps:mode==='chain'?[{title:'Один'},{title:'Два'}]:mode==='graph'?[{title:'Корень',dependsOn:[]},{title:'Ветка',dependsOn:[0]}]:[],active:true,required:true,createdOn:date,startsOn:'',endsOn:'',time:'',weekdays:[0,1,2,3,4,5,6]})),days:{}};
  let afterRead=null;
  const writes=[],opened=[];const invoke=async(name,args)=>{if(name==='get_ui_state'){const raw=JSON.stringify(state);const callback=afterRead;afterRead=null;callback?.(state);return raw;}if(name==='set_ui_state'){writes.push(args);assert.equal(args.expectedValue,JSON.stringify(state));state=JSON.parse(args.value);return;}throw Error(name);};
  const dispose=mountCalendarRoutineChoices(host,{invoke,now:()=>new Date(date+'T12:00:00'),openRoutine:value=>opened.push(value)});t.after(()=>{dispose();dom.window.close();});await tick();
  return{dom,host,writes,opened,state:()=>state,afterNextRead:callback=>{afterRead=callback;},choose:id=>host.querySelector(`[data-routine-choice="${id}"]`).click()};
}
test('check routines mark canonically once; chains only open their owner runner',async t=>{const x=await boot(t);x.choose('check');x.choose('check');await tick();assert.equal(x.writes.length,1);assert.equal(x.state().days['2026-09-27'].check.status,'done');assert.equal(x.host.querySelector('[data-routine-choice="check"]'),null);x.choose('chain');await tick();assert.deepEqual(x.opened,[{id:'chain',date:'2026-09-27',start:true}]);assert.equal(x.writes.length,1);});
test('remote completion between rendering and click cannot be overwritten',async t=>{const x=await boot(t);x.state().days['2026-09-27']={check:{snapshot:x.state().plans[0],status:'done'}};x.choose('check');await tick();assert.equal(x.writes.length,0);assert.match(x.host.querySelector('[role="alert"]').textContent,/уже отмечена/);});
for(const status of ['done','skipped'])test(`a ${status} mark arriving after click revalidation is preserved`,async t=>{
  const x=await boot(t);
  x.afterNextRead(state=>{state.days['2026-09-27']={check:{snapshot:state.plans[0],status}};});
  x.choose('check');await tick();
  assert.equal(x.state().days['2026-09-27'].check.status,status,'the latest confirmed mark survives a stale pending action');
  assert.equal(x.writes.length,0,'a stale action cannot rewrite the latest snapshot');
  assert.match(x.host.querySelector('[role="alert"]').textContent,/уже отмечена/);
  assert.equal(x.opened.length,0,'a conflicting check mark never starts a routine');
});
test('graph routine stays on the shared Start list and only opens execution after an explicit click',async t=>{const x=await boot(t);const button=x.host.querySelector('[data-routine-choice="graph"]');assert.match(button.parentElement.textContent,/2 связанных шагов/);button.click();await tick();assert.deepEqual(x.opened,[{id:'graph',date:'2026-09-27',start:true}]);assert.equal(x.writes.length,0);});
test('routine no-op refresh retains focused action DOM',async t=>{const x=await boot(t);const button=x.host.querySelector('[data-routine-choice="chain"]');button.focus();x.dom.window.dispatchEvent(new x.dom.window.Event('hanni:calendar-refresh'));await tick();assert.equal(x.host.querySelector('[data-routine-choice="chain"]'),button);assert.equal(x.dom.window.document.activeElement,button);});
test('a085 picker target3 marks same routine three times and rejects a stale partial count',async t=>{
  const x=await boot(t);Object.assign(x.state().plans[0],{mode:'count',dailyTarget:3,required:false});x.dom.window.dispatchEvent(new x.dom.window.Event('hanni:calendar-refresh'));await tick();
  x.choose('check');await tick();assert.equal(x.state().days['2026-09-27'].check.completedCount,1);assert.match(x.host.textContent,/осталось 2/);
  x.state().days['2026-09-27'].check.completedCount=2;x.choose('check');await tick();assert.equal(x.writes.length,1);assert.match(x.host.textContent,/уже отмечена/);
  x.dom.window.dispatchEvent(new x.dom.window.Event('hanni:calendar-refresh'));await tick();x.choose('check');await tick();
  assert.equal(x.state().days['2026-09-27'].check.completedCount,3);assert.equal(x.host.querySelector('[data-routine-choice="check"]'),null);assert.equal(x.state().plans.length,3);assert.equal(x.opened.length,0);assert.equal(x.state().plans[0].required,false);
});

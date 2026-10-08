import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountCalendarDayLifecycle } from '../src/hanni/js/calendar-day-lifecycle.js';
const microtasks=async()=>{for(let i=0;i<15;i++)await Promise.resolve();};
test('old async close must not clear the next day dialog owner',async t=>{
 const dom=new JSDOM('<main></main>',{url:'https://synthetic.test'}),w=dom.window,host=w.document.querySelector('main'),closed=[],commits=[];
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
 w.HTMLDialogElement.prototype.close=function(){this.open=false;closed.push(()=>this.dispatchEvent(new w.Event('close')));};
 const state={scope:'device_local',date:'2026-10-08',local_date:'2026-10-08',offset_minutes:0,next_date:'2026-10-09',token:'a'.repeat(64),day:{closed:false,revision:0,summaries:[],plan_ids:[]},next_day:{closed:false,revision:0,summaries:[],plan_ids:[]},history:[],active_blocks:[],candidates:[]};
 const dispose=mountCalendarDayLifecycle(host,{invoke:async(command,args)=>{if(command==='read_calendar_day')return structuredClone(state);if(command==='commit_calendar_day_action'){commits.push(args.input);if(args.input.action==='close')state.day.closed=true;return {operation_id:args.input.operation_id,action:args.input.action};}throw Error(command);}});
 t.after(()=>{dispose();w.close();});await microtasks();host.querySelector('[data-end-day]').click();await microtasks();
 w.document.querySelector('dialog form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await microtasks();
 assert.equal(commits.length,1);assert.equal(closed.length,1);
 host.querySelector('[data-next-day-plan]').click();await microtasks();const second=w.document.querySelector('dialog[open]');assert.ok(second);
 closed.shift()();
 second.querySelector('form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await microtasks();
 assert.equal(commits.length,2,'the new Plan dialog must still own its submit handler after prior close event');
});

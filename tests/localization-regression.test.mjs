import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {mountStageTime,formatStageDuration,stageTimeParts} from '../src/hanni/js/task-processes.js';
import {taskProgress} from '../src/hanni/js/task-progress.js';
import {mountAppUpdates} from '../src/hanni/js/app-updates.js';
const settle=async()=>{for(let i=0;i<6;i++)await new Promise(resolve=>setImmediate(resolve));};

test('English time history uses local units and deleted-stage labels while preserving stored names',async()=>{
 const dom=new JSDOM('<html lang="en"><section></section></html>'),host=dom.window.document.querySelector('section');
 const row={source_id:'synthetic',process:'p',stage:'s'};
 const processes=[{id:'p',title:'User process',stages:[{id:'s',title:'User stage'}]}];
 const stop=mountStageTime(host,{row,processes,invoke:async()=>[{date:'2026-10-03',start_time:'09:00',duration_seconds:3660}],now:()=>new Date('2026-10-03T12:00:00')});
 await settle();assert.match(host.textContent,/Time by stage: User stage 1 h 1 min/);
 assert.match(host.querySelector('strong').title,/Current stage/);
 stop();dom.window.close();
 assert.equal(formatStageDuration(60,'en'),'1 min');assert.equal(formatStageDuration(7200,'en'),'2 h');
 assert.deepEqual([60,120].map(formatStageDuration),['1 \u043c\u0438\u043d','2 \u043c\u0438\u043d']);
 assert.equal(stageTimeParts({stages:[],stage:'lost',deleted:true},new Map([['lost',60]]),'en')[0].label,'Deleted stage');
 assert.equal(stageTimeParts({stages:[],stage:'lost',deleted:true},new Map([['lost',60],['other',60]]),'en')[0].label,'Deleted stages');
});

test('English progress distinguishes confirmed steps, blocked work and unread review',()=>{
 assert.equal(taskProgress({language:'en',workflow:{steps:[{status:'done'}]}}).label,'Steps completed; task still open');
 assert.equal(taskProgress({language:'en',waiting:true}).label,'Waiting for a response');
 assert.equal(taskProgress({language:'en',reviewReadError:true}).label,'Review status unknown');
 assert.equal(taskProgress({completed:true}).label,'\u0417\u0430\u0432\u0435\u0440\u0448\u0435\u043d\u0430');
});

test('English updater settings localize all phases and retain disabled-channel facts',async()=>{
 const dom=new JSDOM('<html lang="en"><section></section></html>'),host=dom.window.document.querySelector('section'),calls=[];
 const stop=mountAppUpdates(host,{invoke:async command=>{calls.push(command);return{configured:false,installed_version:'0.4.4'};}});
 await settle();assert.equal(host.querySelector('h3').textContent,'App updates');
 assert.match(host.querySelector('[data-update-hint]').textContent,/Background checks are unavailable/);
 assert.equal(host.querySelector('[data-update-check]').textContent,'Check for updates');assert.equal(host.querySelector('[data-update-check]').disabled,true);
 for(const phase of ['checking','current','available','downloading','prepared','deferred','installing','permission_required','confirmation_required','manual_required','installer_opened','error','idle']){
  dom.window.dispatchEvent(new dom.window.CustomEvent('hanni:update-status',{detail:{configured:true,phase,platform:'android-aarch64',version:'0.5.0',installed_version:'0.4.4'}}));
  assert.doesNotMatch(host.querySelector('[data-update-status]').textContent,/[\u0400-\u04ff]/,phase);
 }
 assert.deepEqual(calls,['mvp_update_status']);stop();dom.window.close();
});

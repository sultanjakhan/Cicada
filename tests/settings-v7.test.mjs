import test from 'node:test';import assert from 'node:assert/strict';
const m=await import('../src/hanni/js/calendar-display-preferences.js');
test('legacy fallback',async()=>{const calls=[];const p=await m.loadCalendarPreferences(async(c,a)=>{calls.push(c);return c==='get_ui_state'?null:(a.key.endsWith('first_day')?'sun':'Неделя')});assert.equal(p.first_day,'sun');assert.equal(p.default_view,'Неделя');assert.deepEqual(calls,['get_ui_state','get_app_setting','get_app_setting']);});
test('legacy List preference migrates to month grid',()=>{assert.equal(m.normalizeCalendarPreferences({default_view:'Список'}).default_view,'Месяц');});
test('invalid snapshot rejects without write',async()=>{await assert.rejects(()=>m.loadCalendarPreferences(async()=>'{bad'));});
test('save one acknowledged write',async()=>{let n=0;await m.saveCalendarPreferences({version:1,first_day:'mon',default_view:'Месяц',density:'compact',showCompleted:false},async c=>{if(c==='set_ui_state')n++});assert.equal(n,1);});
test('save failure is not acknowledged',async()=>{await assert.rejects(()=>m.saveCalendarPreferences({},async()=>{throw Error('down')}));});
test('recommendation choices survive save/load while old preferences receive defaults',async()=>{const old=m.normalizeCalendarPreferences({showCompleted:true});assert.equal(old.recommendationsEnabled,true);let raw;await m.saveCalendarPreferences({...old,recommendTasks:false,recommendRoutines:true},async(_,{value})=>{raw=value;});const loaded=await m.loadCalendarPreferences(async()=>raw);assert.equal(loaded.recommendTasks,false);assert.equal(loaded.recommendRoutines,true);assert.throws(()=>m.normalizeCalendarPreferences({recommendTasks:'yes'}));});

test('recommendation save uses an expected empty state and rejects a concurrent update',async()=>{
  let write;await m.saveRecommendationPreferences({recommendTasks:false},async(c,a)=>{if(c==='set_ui_state'){write=a;return;}return null;});
  assert.equal(write.expectedValue,'');assert.equal(JSON.parse(write.value).recommendTasks,false);
  await assert.rejects(()=>m.saveRecommendationPreferences({recommendTasks:false},async c=>{if(c==='set_ui_state')throw 'mvp_sync_stale_ui_state';return null;}),/Настройки изменились/);
});

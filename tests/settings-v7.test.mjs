import test from 'node:test';import assert from 'node:assert/strict';
const m=await import('../src/hanni/js/calendar-display-preferences.js');
test('legacy fallback',async()=>{const calls=[];const p=await m.loadCalendarPreferences(async(c,a)=>{calls.push(c);return c==='get_ui_state'?null:(a.key.endsWith('first_day')?'sun':'Неделя')});assert.equal(p.first_day,'sun');assert.equal(p.default_view,'Неделя');assert.deepEqual(calls,['get_ui_state','get_app_setting','get_app_setting']);});
test('legacy List preference migrates to month grid',()=>{assert.equal(m.normalizeCalendarPreferences({default_view:'Список'}).default_view,'Месяц');});
test('invalid snapshot rejects without write',async()=>{await assert.rejects(()=>m.loadCalendarPreferences(async()=>'{bad'));});
test('save one acknowledged write',async()=>{let n=0;await m.saveCalendarPreferences({version:1,first_day:'mon',default_view:'Месяц',density:'compact',showCompleted:false},async c=>{if(c==='set_ui_state')n++});assert.equal(n,1);});
test('save failure is not acknowledged',async()=>{await assert.rejects(()=>m.saveCalendarPreferences({},async()=>{throw Error('down')}));});

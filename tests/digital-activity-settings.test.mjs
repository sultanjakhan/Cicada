import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const tick=async()=>{await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));};
async function boot(t,{failFirst=false,erasureHandler}={}){
  const dom=new JSDOM('<main></main>',{url:'http://fixture.invalid'}),devices=[];let failStatus=failFirst,listener=null;
  Object.assign(globalThis,{window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,CustomEvent:dom.window.CustomEvent});
  Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});
  globalThis.marked={Marked:class{use(){} parse(value){return value;}}};
  dom.window.__TAURI__={core:{invoke:async(command,args={})=>{
    if(erasureHandler && ['digital_activity_preview_erasure','digital_activity_erase_history'].includes(command))return erasureHandler(command,args);
    if(command==='digital_activity_status'){if(failStatus){failStatus=false;throw Error('offline');}return{enabled:devices.some(item=>item.enabled),devices:structuredClone(devices)};}
    if(command==='digital_activity_save_connection'){const input=args.input;const old=devices.find(item=>item.id===input.id);const device={id:input.id||`device-${devices.length+1}`,label:input.label,port:input.port,endpoint:input.endpoint||'http://127.0.0.1',enabled:input.enabled,source:input.source,lastSuccess:null,lastError:null,records:0};if(old)Object.assign(old,device);else devices.push(device);return{id:device.id,saved:true};}
    if(command==='digital_activity_remove_connection'){const index=devices.findIndex(device=>device.id===args.deviceId);if(index<0)throw Error('not found');devices.splice(index,1);return{id:args.deviceId,removed:true};}
    if(command==='digital_activity_import_now'){return{imported:1,changed:1,skipped:0,errors:[],days:['2026-09-27']};}
    throw Error(command);
  }},event:{listen:async(_name,handler)=>{listener=handler;return()=>{listener=null;};}}};
  const {mountDigitalActivitySettings}=await import(`../src/hanni/js/digital-activity-settings.js?${Math.random()}`);const host=dom.window.document.querySelector('main'),pending=[];
  const dispose=mountDigitalActivitySettings(host,{invoke:(...args)=>dom.window.__TAURI__.core.invoke(...args),setPending:value=>pending.push(value)});t.after(()=>{dispose();dom.window.close();});await tick();
  return{dom,host,devices,pending,failStatus:()=>{failStatus=true;},emit:()=>listener?.({payload:{changed:1,days:['2026-09-27']}})};
}

test('connection form saves platform and port; token stays write-only and auto-import can pause',async t=>{
  const x=await boot(t);x.host.querySelector('[data-da-add]').click();
  x.host.querySelector('[data-da-label]').value='Телефон';x.host.querySelector('[data-da-source]').value='android';x.host.querySelector('[data-da-port]').value='5601';x.host.querySelector('[data-da-enabled]').checked=true;x.host.querySelector('[data-da-token]').value='secret';
  x.host.querySelector('[data-da-save]').click();await tick();
  assert.deepEqual({...x.devices[0],lastSuccess:undefined,lastError:undefined,records:undefined},{id:'device-1',label:'Телефон',port:5601,endpoint:'http://127.0.0.1',enabled:true,source:'android',lastSuccess:undefined,lastError:undefined,records:undefined});
  assert.equal(x.host.querySelector('[data-da-token]').value,'');assert.match(x.host.textContent,/Android · порт 5601/);
  x.host.querySelector('[data-da-toggle="device-1"]').click();await tick();assert.equal(x.devices[0].enabled,false);assert.match(x.host.textContent,/приостановлен/);
  assert.deepEqual(x.pending,[true,false,true,false]);
  x.host.querySelector('[data-da-edit="device-1"]').click();
  const label=x.host.querySelector('[data-da-label]'),importButton=x.host.querySelector('[data-da-import="device-1"]');
  label.value='Черновик';label.dispatchEvent(new x.dom.window.Event('input',{bubbles:true}));label.dispatchEvent(new x.dom.window.Event('change',{bubbles:true}));
  assert.equal(importButton.isConnected,true,'blur must not replace the button during its first click');
  importButton.click();assert.match(x.host.querySelector('[data-da-error]').textContent,/Сначала сохрани или отмени/);
  assert.equal(x.devices[0].label,'Телефон');
});

async function addErasureDevice(x) {
  x.devices.push({id:'one',label:'Тестовый ПК',port:5600,enabled:false,source:'windows',records:3});
  x.emit();await tick();x.host.querySelector('[data-da-erase="one"]').click();
}

test('history deletion previews one device/date and requires a separate confirmation',async t=>{
  const calls=[];
  const x=await boot(t,{erasureHandler:async(command,args)=>{calls.push({command,args});return command==='digital_activity_preview_erasure'?{...args,count:3,deletedThrough:null}:{deleted:3,deletedThrough:args.throughDate};}});
  await addErasureDevice(x);assert.equal(calls.length,0);
  const date=x.host.querySelector('[data-erasure-date]');date.value='2026-09-20';date.dispatchEvent(new x.dom.window.Event('input'));
  x.host.querySelector('[data-erasure-preview]').click();await tick();
  assert.deepEqual(calls,[{command:'digital_activity_preview_erasure',args:{deviceId:'one',throughDate:'2026-09-20'}}]);
  assert.match(x.host.querySelector('[data-erasure-result]').textContent,/3/);
  assert.equal(x.host.querySelector('[data-erasure-confirm]').hidden,false);
  x.host.querySelector('[data-erasure-confirm]').click();await tick();
  assert.deepEqual(calls[1],{command:'digital_activity_erase_history',args:{deviceId:'one',throughDate:'2026-09-20',expectedCount:3}});
  assert.equal(x.host.querySelector('[data-da-erasure]').hidden,true);
  assert.match(x.host.querySelector('[data-da-message]').textContent,/Удалено дневных итогов: 3/);
  assert.deepEqual(x.pending,[true,false,true,false]);
});

test('changed date invalidates preview; background refresh keeps the chosen date; cancel never deletes',async t=>{
  const calls=[];
  const x=await boot(t,{erasureHandler:async(command,args)=>{calls.push(command);return{...args,count:2};}});
  await addErasureDevice(x);const date=x.host.querySelector('[data-erasure-date]');date.value='2026-09-19';date.dispatchEvent(new x.dom.window.Event('input'));
  x.host.querySelector('[data-erasure-preview]').click();await tick();
  x.emit();await tick();assert.equal(date.isConnected,true);assert.equal(date.value,'2026-09-19');
  date.value='2026-09-20';date.dispatchEvent(new x.dom.window.Event('input'));
  assert.equal(x.host.querySelector('[data-erasure-confirm]').hidden,true);
  x.host.querySelector('[data-erasure-confirm]').click();await tick();
  assert.deepEqual(calls,['digital_activity_preview_erasure']);
  x.host.querySelector('[data-erasure-cancel]').click();
  assert.equal(x.host.querySelector('[data-da-erasure]').hidden,true);
  assert.equal(x.dom.window.document.activeElement,x.host.querySelector('[data-da-erase="one"]'));
});

test('history pending state locks actions and stale count requires a new preview',async t=>{
  let resolvePreview;
  const x=await boot(t,{erasureHandler:(command,args)=>command==='digital_activity_preview_erasure'?new Promise(resolve=>{resolvePreview=()=>resolve({...args,count:1});}):Promise.reject(Error('digital_activity_erasure_count_changed'))});
  await addErasureDevice(x);x.host.querySelector('[data-erasure-preview]').click();
  assert.equal(x.host.querySelector('[data-erasure-date]').disabled,true);
  assert.equal(x.host.querySelector('[data-erasure-cancel]').disabled,true);
  assert.equal(x.host.querySelector('[data-da-import="one"]').disabled,true);
  resolvePreview();await tick();
  x.host.querySelector('[data-erasure-confirm]').click();await tick();
  assert.match(x.host.querySelector('[data-erasure-error]').textContent,/Количество итогов изменилось/);
  assert.equal(x.host.querySelector('[data-erasure-confirm]').hidden,true);
  assert.equal(x.host.querySelector('[data-erasure-preview]').disabled,false);
});

test('mismatched native preview and future date never permit history deletion',async t=>{
  let calls=0;
  const x=await boot(t,{erasureHandler:async(_command,args)=>{calls++;return{...args,deviceId:'another',count:1};}});
  await addErasureDevice(x);const date=x.host.querySelector('[data-erasure-date]');date.value='9999-12-31';
  x.host.querySelector('[data-erasure-preview]').click();await tick();assert.equal(calls,0);
  date.value='2026-09-19';date.dispatchEvent(new x.dom.window.Event('input'));x.host.querySelector('[data-erasure-preview]').click();await tick();
  assert.equal(calls,1);assert.equal(x.host.querySelector('[data-erasure-confirm]').hidden,true);
  assert.equal(x.host.querySelector('[data-erasure-error]').hidden,false);
});

test('status failure can retry and manual import exposes a real result',async t=>{
  const x=await boot(t,{failFirst:true});x.devices.push({id:'w',label:'Ноутбук',port:5600,enabled:true,source:'windows',lastSuccess:null,lastError:null,records:3});
  x.host.querySelector('[data-da-retry]').click();await tick();
  assert.equal(x.host.querySelector('[data-da-error]').hidden,true);
  x.host.querySelector('[data-da-import="w"]').click();await tick();
  assert.match(x.host.querySelector('[data-da-message]').textContent,/новых или обновлённых дней: 1/);
  assert.equal(x.host.textContent.includes('Токен'),true);
});


test('removing a connection requires the inline choice and preserves other connections',async t=>{
  const x=await boot(t);
  x.devices.push({id:'one',label:'Первое',port:5600,enabled:false,source:'windows',records:2},{id:'two',label:'Второе',port:15600,enabled:false,source:'android',records:3});
  x.emit();await tick();
  x.host.querySelector('[data-da-remove="one"]').click();
  assert.equal(x.devices.length,2);assert.match(x.host.textContent,/Дневные события останутся/);
  x.host.querySelector('[data-da-keep="one"]').click();assert.equal(x.devices.length,2);
  x.host.querySelector('[data-da-remove="one"]').click();
  x.host.querySelector('[data-da-confirm-remove="one"]').click();await tick();
  assert.deepEqual(x.devices.map(device=>device.id),['two']);
  assert.match(x.host.querySelector('[data-da-message]').textContent,/Дневные события сохранены/);
  assert.equal(x.dom.window.document.activeElement,x.host.querySelector('[data-da-add]'));
});

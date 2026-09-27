import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const tick=async()=>{await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));};
async function boot(t,{failFirst=false}={}){
  const dom=new JSDOM('<main></main>',{url:'http://fixture.invalid'}),devices=[];let failStatus=failFirst,listener=null;
  Object.assign(globalThis,{window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,CustomEvent:dom.window.CustomEvent});
  Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});
  globalThis.marked={Marked:class{use(){} parse(value){return value;}}};
  dom.window.__TAURI__={core:{invoke:async(command,args={})=>{
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

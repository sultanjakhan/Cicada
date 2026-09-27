import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { openCalendarCreateMenu } from '../src/hanni/js/calendar-create-menu.js';

function fixture(t) {
  const dom=new JSDOM('<button id="create">Создать</button><button id="next">Начать</button>');
  t.after(()=>dom.window.close());
  return {w:dom.window,d:dom.window.document,trigger:dom.window.document.querySelector('#create')};
}
test('create menu offers every record kind, keyboard selects a wish without creating another record',t=>{
  const {w,d,trigger}=fixture(t),selected=[];
  openCalendarCreateMenu(trigger,{onSelect:kind=>selected.push(kind)});
  assert.equal(trigger.getAttribute('aria-expanded'),'true');
  assert.equal(d.querySelectorAll('[role=menuitem]').length,6);
  d.activeElement.dispatchEvent(new w.KeyboardEvent('keydown',{key:'End',bubbles:true}));
  assert.equal(d.activeElement.dataset.createKind,'routine');
  d.activeElement.dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}));
  d.activeElement.click();
  assert.deepEqual(selected,['wish']);
  assert.equal(d.querySelector('[role=menu]'),null);
  assert.equal(trigger.getAttribute('aria-expanded'),'false');
});
test('Escape returns focus, outside click preserves destination focus and disposal never submits',t=>{
  const {w,d,trigger}=fixture(t);let calls=0;
  openCalendarCreateMenu(trigger,{onSelect:()=>calls++,initialKind:'note'});
  assert.equal(d.activeElement.dataset.createKind,'note');
  d.activeElement.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  assert.equal(d.activeElement,trigger);
  const close=openCalendarCreateMenu(trigger,{onSelect:()=>calls++});
  const next=d.querySelector('#next');next.focus();next.dispatchEvent(new w.Event('pointerdown',{bubbles:true}));
  assert.equal(d.activeElement,next);assert.equal(d.querySelector('[role=menu]'),null);
  close();assert.equal(calls,0);
});
test('a replaced workspace dismisses the menu and stale choices cannot save',async t=>{
  const {d,trigger}=fixture(t);let calls=0;
  openCalendarCreateMenu(trigger,{onSelect:()=>calls++});
  const item=d.querySelector('[data-create-kind=task]');trigger.remove();
  await Promise.resolve();item.click();
  assert.equal(d.querySelector('[role=menu]'),null);assert.equal(calls,0);
});

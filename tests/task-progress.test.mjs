import test from 'node:test';
import assert from 'node:assert/strict';
import {taskProgress} from '../src/hanni/js/task-progress.js';
test('inactive timer does not erase confirmed manual running workflow',()=>{assert.equal(taskProgress({workflow:{steps:[{status:'running'}]},timerActive:false}).state,'running');});
test('active timer does not erase blocked workflow or stage',()=>{assert.equal(taskProgress({workflow:{steps:[{status:'blocked'}]},timerActive:true}).state,'blocked');assert.equal(taskProgress({waiting:true,timerActive:true}).state,'blocked');});
test('no workflow uses existing timer fallback; descriptions and prepared code cannot complete tasks',()=>{assert.equal(taskProgress({workflow:{steps:[],result:'Prepared code'}}),null);assert.equal(taskProgress({workflow:{steps:[{status:'done'}],result:'Prepared code'}}).state,'planned');});
test('explicit review errors fail closed and descriptions never imply review',()=>{assert.equal(taskProgress({reviewReadError:true,review:{reviewState:'awaiting_review'}}).state,'unknown');assert.equal(taskProgress({review:{reviewState:'awaiting_review'}}).state,'review');assert.equal(taskProgress({description:'needs review'}),null);});

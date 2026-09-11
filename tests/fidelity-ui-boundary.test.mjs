import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = name => readFile(new URL(`../src/hanni/js/${name}`, import.meta.url), 'utf8');

test('workspace keeps the four Calendar panes and excludes Routine', async () => {
  const source = await read('calendar-workspace.js');
  for (const pane of ['dash', 'table', 'goals', 'notes']) assert.match(source, new RegExp(`id:'${pane}'`));
  assert.doesNotMatch(source, /calendar-routine\.js|id:'routine'|renderRoutine/);
});

test('workspace has no shopping, template, or health-refresh dependency', async () => {
  const sources = await Promise.all(['calendar-workspace.js', 'calendar-event-modal.js'].map(read));
  const text = sources.join('\n');
  assert.doesNotMatch(text, /shopping-list\.js|calendar-event-templates\.js|health-view-refresh\.js/);
});

test('calendar source IDs stay strings for the UUID backend', async () => {
  const source = await read('calendar-workspace.js');
  assert.match(source, /id: String\(record\.source_id\)/);
  assert.doesNotMatch(source, /Number\(record\.source_id\)/);
});

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
  const text = (await Promise.all(['calendar-workspace.js', 'calendar-event-modal.js'].map(read))).join('\n');
  assert.doesNotMatch(text, /shopping-list\.js|calendar-event-templates\.js|health-view-refresh\.js/);
});
test('calendar source IDs stay strings for the UUID backend', async () => {
  const source = await read('calendar-workspace.js');
  assert.match(source, /id: String\(record\.source_id\)/);
  assert.doesNotMatch(source, /Number\(record\.source_id\)/);
});
test('unified layout preserves upstream header and stale-render guard', async () => {
  const source = await read('unified-layout.js');
  for (const className of ['uni-header', 'uni-header-name', 'uni-header-desc', 'uni-tabs', 'uni-content']) assert.ok(source.includes(`class=\"${className}`));
  assert.match(source, /renderRevisions\.get\(el\) !== revision/);
});

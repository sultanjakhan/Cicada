import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { mountTaskFilterFocusFixture } from './fixtures/task-filter-focus.mjs';

test('synthetic visual fixture prepares real component scenes without native task writes', async t => {
  const html = await readFile(new URL('./fixtures/task-filter-focus.html', import.meta.url), 'utf8');
  for (const theme of ['light', 'dark']) {
    for (const scene of ['tabs', 'delete', 'write-error', 'conflict', 'read-error']) {
      await t.test(theme + ' / ' + scene, async () => {
        const url = new URL('http://127.0.0.1:21485/tests/fixtures/task-filter-focus.html?theme=' + theme + '&scene=' + scene);
        const dom = new JSDOM(html, {url:url.href, pretendToBeVisual:true});
        const fixture = mountTaskFilterFocusFixture(dom.window.document, url);
        try {
          await fixture.ready;
          const doc = dom.window.document;
          assert.equal(doc.documentElement.dataset.fixtureReady, 'yes');
          assert.equal(doc.documentElement.dataset.theme, theme);
          assert.equal(doc.querySelectorAll('[data-context-record]').length, 2);
          assert.match(doc.querySelector('[data-fixture-status]').textContent, /Задачи сохранены: да/);
          assert.ok(fixture.commands.every(command => ['get_calendar_tasks', 'get_goals', 'get_calendar_task_goals', 'get_calendar_task_blocks', 'get_ui_state', 'set_ui_state'].includes(command)));
          if (scene === 'delete') {
            assert.equal(doc.activeElement, doc.querySelector('[data-task-view-keep]'));
            const shownIds = [...doc.querySelectorAll('[data-context-record]')].map(row => row.dataset.contextRecord);
            const confirm = doc.querySelector('[data-task-view-confirm-remove]');
            confirm.focus();
            confirm.click();
            await new Promise(resolve => dom.window.setTimeout(resolve, 0));
            assert.deepEqual([...doc.querySelectorAll('[data-context-record]')].map(row => row.dataset.contextRecord), shownIds);
            assert.deepEqual(JSON.parse(fixture.getRaw()).views.map(view => view.id), ['fixture-home']);
            assert.equal(doc.activeElement, doc.querySelector('[data-task-view-create]'));
          }
          if (scene === 'write-error') assert.match(doc.querySelector('.ct-view-tabs-status').textContent, /Не удалось сохранить/);
          if (scene === 'conflict') assert.match(doc.querySelector('.ct-view-tabs-status').textContent, /другом окне/);
          if (scene === 'read-error') assert.match(doc.querySelector('.ct-view-tabs-status').textContent, /Не удалось загрузить/);
        } finally {
          fixture.dispose();
          dom.window.close();
        }
      });
    }
  }
});

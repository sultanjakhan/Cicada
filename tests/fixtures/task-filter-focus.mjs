import { mountCalendarTasks } from '../../src/hanni/js/calendar-tasks.js';
import { DEFAULT_TASK_FILTERS, TASK_FILTER_VIEWS_KEY } from '../../src/hanni/js/task-filter-views.js';

const SCENES = new Set(['tabs', 'delete', 'write-error', 'conflict', 'read-error']);
const LONG_TITLE = 'Синтетическая подборка задач с длинным названием для проверки переноса и фокуса';
const VIEW_ID = 'fixture-view';

// A browser-only fixture, never a native adapter or a second task store.
export function mountTaskFilterFocusFixture(doc, url) {
  const scene = SCENES.has(url.searchParams.get('scene')) ? url.searchParams.get('scene') : 'tabs';
  const theme = url.searchParams.get('theme') === 'dark' ? 'dark' : 'light';
  doc.documentElement.dataset.theme = theme;
  for (const link of doc.querySelectorAll('[data-fixture-scene]')) {
    link.href = '?theme=' + theme + '&scene=' + link.dataset.fixtureScene;
  }
  const rows = Object.freeze([
    Object.freeze({ source_type:'note', source_id:'00000000-0000-4000-8000-000000000001', title:'Синтетическая задача: проверить клавиатуру', status_extra:'task', sphere:'personal', date:null, completed:false }),
    Object.freeze({ source_type:'note', source_id:'00000000-0000-4000-8000-000000000002', title:'Синтетическая задача: проверить перенос длинного названия в узком окне', status_extra:'task', sphere:'home', date:null, completed:false }),
    Object.freeze({ source_type:'note', source_id:'00000000-0000-4000-8000-000000000003', title:'Синтетическая завершённая задача', status_extra:'done', sphere:'personal', date:null, completed:true }),
  ]);
  const taskSnapshot = JSON.stringify(rows);
  const seed = {
    version:1,
    views:[
      { id:VIEW_ID, title:LONG_TITLE, filters:{...DEFAULT_TASK_FILTERS} },
      { id:'fixture-home', title:'Дом', filters:{...DEFAULT_TASK_FILTERS, sphere:'personal', personal:'home'} },
    ],
  };
  let raw = JSON.stringify(seed);
  let failWrites = false;
  let writes = 0;
  const commands = [];
  const status = doc.querySelector('[data-fixture-status]');
  const updateEvidence = () => {
    status.textContent = 'Сценарий: ' + scene + '. Синтетических задач: ' + rows.length
      + '. Записей подборок: ' + writes + '. Задачи сохранены: ' + (JSON.stringify(rows) === taskSnapshot ? 'да' : 'нет') + '.';
  };
  const invoke = async (command, args = {}) => {
    commands.push(command);
    if (command === 'get_calendar_tasks') return rows;
    if (['get_goals', 'get_calendar_task_goals', 'get_calendar_task_blocks'].includes(command)) return [];
    if (command === 'get_ui_state') {
      if (args.key !== TASK_FILTER_VIEWS_KEY) return null;
      if (scene === 'read-error') throw Error('Синтетическая ошибка чтения');
      return raw;
    }
    if (command === 'set_ui_state' && args.key === TASK_FILTER_VIEWS_KEY) {
      if (failWrites) throw Error('Синтетическая ошибка записи');
      if (args.expectedValue !== raw) throw Error('mvp_sync_stale_ui_state');
      raw = args.value;
      writes++;
      updateEvidence();
      return null;
    }
    throw Error('В стенде запрещена native-команда: ' + command);
  };
  const contexts = new Map(rows.map(row => ['note:' + row.source_id, {
    sources:[], projects:[], tags:[], observations:[], reports:[], review:null,
  }]));
  const state = {...DEFAULT_TASK_FILTERS, taskViewId:VIEW_ID, page:0};
  const dispose = mountCalendarTasks(doc.querySelector('#tasks'), {
    invoke, state,
    openTask:() => { status.textContent = 'Детали задач в этом стенде не открываются.'; },
    editDate:() => { status.textContent = 'Даты задач в этом стенде не меняются.'; },
    executeAction:async () => { throw Error('Исполнение задач в синтетическом стенде отключено.'); },
    notifyChange:() => {},
    readTaskObservations:async () => ({available:true, unboundCount:0, contexts}),
  });
  const flush = () => new Promise(resolve => doc.defaultView.setTimeout(resolve, 0));
  const ready = (async () => {
    await flush();
    if (['delete', 'write-error', 'conflict'].includes(scene)) {
      doc.querySelector('[data-task-view-edit]').click();
      const remove = doc.querySelector('[data-task-view-remove]');
      remove.focus();
      remove.click();
      if (scene === 'write-error') failWrites = true;
      if (scene === 'conflict') {
        const external = JSON.parse(raw);
        external.views[0].title = 'Синтетическая правка в другом окне';
        raw = JSON.stringify(external);
      }
      if (scene !== 'delete') {
        const confirm = doc.querySelector('[data-task-view-confirm-remove]');
        confirm.focus();
        confirm.click();
        await flush();
      }
    }
    updateEvidence();
    doc.documentElement.dataset.fixtureReady = 'yes';
  })();
  return { ready, dispose, rows, commands, state, getRaw:() => raw };
}

if (typeof document !== 'undefined') {
  const fixture = mountTaskFilterFocusFixture(document, new URL(location.href));
  window.addEventListener('pagehide', fixture.dispose, {once:true});
}

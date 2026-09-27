import { createCalendarDialog } from './calendar-dialog.js';
import { escapeHtml } from './utils.js';

const esc = value => escapeHtml(String(value ?? ''));
const WEEKDAYS = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
let nextStepId = 0;

function makeStep(title = '', trackingMode = 'track', optional = false, dependsOn = []) {
  return { id: `routine-step-${++nextStepId}`, title, trackingMode, optional, dependsOn: new Set(dependsOn) };
}
function descendants(steps, id) {
  const found = new Set(), queue = [id];
  while (queue.length) {
    const parent = queue.shift();
    for (const step of steps) if (step.dependsOn.has(parent) && !found.has(step.id)) { found.add(step.id); queue.push(step.id); }
  }
  return found;
}
function cyclic(steps) {
  const visiting = new Set(), visited = new Set();
  const visit = id => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const step = steps.find(item => item.id === id);
    for (const parent of step?.dependsOn || []) if (visit(parent)) return true;
    visiting.delete(id); visited.add(id); return false;
  };
  return steps.some(step => visit(step.id));
}
function cloneSteps(steps) { return steps.map(step => makeStep(step.title, step.trackingMode, step.optional, step.dependsOn)); }

/** A short-form routine editor; store.savePlan's expectedPlan keeps concurrent edits safe. */
export function openCalendarRoutineEditor({ document, store, plan = null, kind = 'action', returnFocus, isCurrent = () => true, onSaved = () => {}, onClose = () => {} }) {
  const expectedPlan = plan ? JSON.parse(JSON.stringify(plan)) : null;
  let currentKind = plan?.kind || kind;
  let mode = plan?.mode || 'check';
  let layout = ['chain', 'graph'].includes(mode) ? 'multi' : 'single';
  let title = plan?.title || '';
  let weekdays = [...(plan?.weekdays || [0, 1, 2, 3, 4, 5, 6])];
  let startsOn = plan?.startsOn || '', endsOn = plan?.endsOn || '', time = plan?.time || '';
  let active = plan?.active !== false, required = plan?.required !== false;
  let singleMode = mode === 'activity' ? 'activity' : 'check';
  let steps = [];
  if (mode === 'graph') {
    steps = (plan.steps || []).map(step => makeStep(step.title, step.trackingMode || 'track', step.optional ?? false));
    steps.forEach((step, index) => step.dependsOn = new Set((plan.steps[index].dependsOn || []).map(parent => steps[parent]?.id).filter(Boolean)));
  } else if (mode === 'chain') {
    steps = (plan.steps || []).map(step => makeStep(step.title, 'track', false));
    steps.forEach((step, index) => step.dependsOn = new Set(index ? [steps[index - 1].id] : []));
  }
  let savedMultiDraft = null, savedMultiMode = null;
  let collapseConfirm = false, deleteConfirm = null;

  const dialog = createCalendarDialog({
    document, title: plan ? 'Изменить рутину' : 'Новая рутина',
    hint: 'Сначала название и действие. Расписание и редкие настройки раскрываются отдельно.',
    submitLabel: 'Сохранить', returnFocus, isCurrent, onClose,
  });
  const body = dialog.body;

  function capture() {
    title = body.querySelector('[data-routine-title]')?.value ?? title;
    weekdays = [...body.querySelectorAll('[data-routine-weekday]:checked')].map(input => Number(input.value));
    startsOn = body.querySelector('[data-routine-starts]')?.value || '';
    endsOn = body.querySelector('[data-routine-ends]')?.value || '';
    time = body.querySelector('[data-routine-time]')?.value || '';
    active = body.querySelector('[data-routine-active]')?.checked ?? active;
    required = body.querySelector('[data-routine-required]')?.checked ?? required;
    const singleTracking = body.querySelector('[data-routine-single-track]');
    if (singleTracking) singleMode = singleTracking.checked ? 'activity' : 'check';
    body.querySelectorAll('[data-routine-step]').forEach(row => {
      const step = steps.find(item => item.id === row.dataset.routineStep);
      if (!step) return;
      step.title = row.querySelector('[data-step-title]')?.value ?? step.title;
      step.trackingMode = row.querySelector('[data-step-tracking]')?.value ?? step.trackingMode;
      step.optional = row.querySelector('[data-step-optional]')?.checked ?? step.optional;
    });
  }

  function optionRows(step) {
    const blocked = descendants(steps, step.id);
    return steps.filter(candidate => candidate.id !== step.id).map(candidate => {
      const isBlocked = blocked.has(candidate.id);
      return `<label class="cre-dependency${isBlocked ? ' is-disabled' : ''}"><input type="checkbox" data-step-dependency value="${esc(candidate.id)}" ${step.dependsOn.has(candidate.id) ? 'checked' : ''} ${isBlocked ? 'disabled' : ''}><span>${esc(candidate.title || 'Без названия')}</span>${isBlocked ? '<small>Создаст цикл</small>' : ''}</label>`;
    }).join('') || '<p class="cre-muted">Других шагов пока нет.</p>';
  }

  function deleteEffects(step) {
    if (mode === 'chain') {
      const index = steps.indexOf(step), next = steps[index + 1], prior = steps[index - 1];
      return next ? [{ step: next, after: prior ? [prior.title || 'Без названия'] : [] }] : [];
    }
    return steps.filter(candidate => candidate.dependsOn.has(step.id)).map(child => {
      const after = new Set([...child.dependsOn].filter(id => id !== step.id));
      for (const parent of step.dependsOn) after.add(parent);
      return { step: child, after: [...after].map(id => steps.find(item => item.id === id)?.title || 'Без названия') };
    });
  }

  function render(focusStep = null, focusSelector = null) {
    const advancedOpen = Boolean(body.querySelector('.cre-advanced[open]'));
    const openSteps = new Set([...body.querySelectorAll('.cre-step-options[open]')].map(node => node.dataset.optionsFor));
    const multi = layout === 'multi';
    body.innerHTML = `<div class="calendar-routine-editor">
      <label class="cre-title">Название<input data-routine-title maxlength="160" autocomplete="off" placeholder="Например, Утренний порядок" value="${esc(title)}"></label>
      <fieldset class="cre-layout" aria-label="Структура рутины"><legend>Что повторяется</legend><div><button type="button" data-layout="single" aria-pressed="${!multi}" ${currentKind === 'rule' ? 'disabled' : ''}>Одно действие</button><button type="button" data-layout="multi" aria-pressed="${multi}" ${currentKind === 'rule' ? 'disabled' : ''}>Несколько шагов</button></div>${currentKind === 'rule' ? '<small>Правило отмечается целиком.</small>' : ''}</fieldset>
      ${multi ? `<section class="cre-steps" aria-labelledby="cre-steps-heading"><div class="cre-steps-heading"><h3 id="cre-steps-heading">Шаги</h3><span>${steps.length} из 50</span></div>${steps.map((step, index) => `<article class="cre-step" data-routine-step="${esc(step.id)}"><header><label><span class="cre-step-number">${index + 1}</span><input data-step-title maxlength="160" aria-label="Шаг ${index + 1}" placeholder="Название шага" value="${esc(step.title)}"></label><div class="cre-step-order"><button type="button" data-move-step="up" data-step-id="${esc(step.id)}" aria-label="Переместить шаг ${index + 1} выше" ${index === 0 ? 'disabled' : ''}>↑</button><button type="button" data-move-step="down" data-step-id="${esc(step.id)}" aria-label="Переместить шаг ${index + 1} ниже" ${index === steps.length - 1 ? 'disabled' : ''}>↓</button><button type="button" data-remove-step="${esc(step.id)}" aria-label="Удалить шаг ${index + 1}">Удалить</button></div></header><details class="cre-step-options" data-options-for="${esc(step.id)}"><summary>Настройки шага</summary><label class="cre-toggle"><input type="checkbox" data-step-optional ${step.optional ? 'checked' : ''}> Можно пропустить</label><label class="cre-field">Учёт времени<select data-step-tracking><option value="track" ${step.trackingMode === 'track' ? 'selected' : ''}>Учитывать время</option><option value="check" ${step.trackingMode === 'check' ? 'selected' : ''}>Только отметка</option></select></label><fieldset class="cre-dependencies"><legend>После…</legend><p class="cre-muted">Выбери, какие шаги должны завершиться. Пусто — можно начать сразу.</p>${optionRows(step)}</fieldset></details>${deleteConfirm === step.id ? `<div class="cre-delete-confirm" role="alert"><p>${deleteEffects(step).length ? `Изменится связь «После…»: ${deleteEffects(step).map(change => `«${esc(change.step.title || 'Без названия')}» → ${change.after.length ? change.after.map(esc).join(', ') : 'можно начать сразу'}`).join('; ')}.` : 'Удаление шага изменит порядок оставшихся шагов.'} Продолжить?</p><button type="button" data-confirm-delete="${esc(step.id)}">Удалить шаг</button><button type="button" data-cancel-delete>Оставить</button></div>` : ''}</article>`).join('')}<button type="button" class="cre-add-step" data-add-step ${steps.length >= 50 ? 'disabled' : ''}>Добавить шаг</button></section>` : '<section class="cre-single"><p class="cre-muted">Одно действие без списка шагов.</p></section>'}
      ${collapseConfirm ? '<div class="cre-change-confirm" role="alert"><p>После сохранения будущие запуски будут без этих шагов. До сохранения их можно вернуть переключателем.</p><button type="button" data-confirm-collapse>Продолжить</button><button type="button" data-cancel-collapse>Отмена</button></div>' : ''}
      <details class="cre-advanced" ${advancedOpen ? 'open' : ''}><summary>Расписание и дополнительные настройки</summary><div class="cre-advanced-fields">${!plan ? `<label class="cre-field">Вид<select data-routine-kind><option value="action" ${currentKind === 'action' ? 'selected' : ''}>Дело</option><option value="rule" ${currentKind === 'rule' ? 'selected' : ''} ${multi ? 'disabled' : ''}>Правило — отмечать соблюдение</option></select></label>` : `<p class="cre-muted">${currentKind === 'rule' ? 'Правило с отметкой соблюдения' : 'Дело'}</p>`}${!multi && currentKind === 'action' ? `<label class="cre-toggle"><input type="checkbox" data-routine-single-track ${singleMode === 'activity' ? 'checked' : ''}> Учитывать затраченное время</label>` : ''}<fieldset class="cre-week"><legend>Дни недели</legend>${[1, 2, 3, 4, 5, 6, 0].map(day => `<label><input type="checkbox" data-routine-weekday value="${day}" ${weekdays.includes(day) ? 'checked' : ''}>${WEEKDAYS[day]}</label>`).join('')}</fieldset><div class="cre-dates"><label>Начало, если нужно<input type="date" data-routine-starts value="${esc(startsOn)}"></label><label>Конец курса, если нужен<input type="date" data-routine-ends value="${esc(endsOn)}"></label><label>Время в списке, если нужно<input type="time" data-routine-time value="${esc(time)}"></label></div><label class="cre-toggle"><input type="checkbox" data-routine-required ${required ? 'checked' : ''}> Обязательное для меня</label><label class="cre-toggle"><input type="checkbox" data-routine-active ${active ? 'checked' : ''}> Расписание действует</label><p class="cre-muted">Время задаёт порядок в списке; уведомления и автозапуск не используются.</p></div></details>
    </div>`;
    for (const options of body.querySelectorAll('.cre-step-options')) if (openSteps.has(options.dataset.optionsFor)) options.open = true;
    if (focusStep) {
      const row = [...body.querySelectorAll('[data-routine-step]')].find(node => node.dataset.routineStep === focusStep);
      const target = focusSelector ? row?.querySelector(focusSelector) : row?.querySelector('[data-step-title]');
      target?.focus();
    }
  }

  function switchChainToGraph() {
    if (mode !== 'chain') return;
    steps.forEach((step, index) => step.dependsOn = new Set(index ? [steps[index - 1].id] : []));
    mode = 'graph';
  }
  function addStep() {
    capture(); if (steps.length >= 50) return;
    const prior = steps.at(-1); steps.push(makeStep('', 'track', false, prior ? [prior.id] : []));
    if (mode !== 'chain') mode = 'graph';
    const id = steps.at(-1).id; render(id, '[data-step-title]');
    body.querySelector(`[data-options-for="${id}"]`)?.setAttribute('open', '');
  }
  function removeStep(id) {
    const index = steps.findIndex(step => step.id === id); if (index < 0) return;
    const step = steps[index], effects = deleteEffects(step);
    if (mode === 'graph') for (const child of effects.map(effect => effect.step)) {
      child.dependsOn.delete(id); for (const parent of step.dependsOn) child.dependsOn.add(parent);
    }
    steps.splice(index, 1); deleteConfirm = null;
    if (mode === 'chain') steps.forEach((item, i) => item.dependsOn = new Set(i ? [steps[i - 1].id] : []));
    render(steps[Math.min(index, steps.length - 1)]?.id || null);
  }
  function setLayout(next) {
    capture(); if (next === layout || currentKind === 'rule') return;
    if (next === 'multi') {
      if (savedMultiDraft) { steps = cloneSteps(savedMultiDraft); mode = savedMultiMode || 'graph'; savedMultiDraft = null; savedMultiMode = null; }
      else { steps = [makeStep(title)]; mode = 'graph'; }
      layout = 'multi'; render(steps[0]?.id); return;
    }
    if (steps.length) { collapseConfirm = true; render(); return; }
    savedMultiDraft = cloneSteps(steps); savedMultiMode = mode;
    singleMode = steps[0]?.trackingMode === 'check' ? 'check' : 'activity';
    steps = []; layout = 'single'; mode = singleMode; render();
  }

  body.addEventListener('change', event => {
    const target = event.target;
    if (target.matches('[data-routine-kind]')) { currentKind = target.value; render(); return; }
    if (target.matches('[data-routine-single-track]')) { singleMode = target.checked ? 'activity' : 'check'; mode = singleMode; return; }
    if (target.matches('[data-step-dependency]')) {
      const row = target.closest('[data-routine-step]'), step = steps.find(item => item.id === row?.dataset.routineStep);
      const id = target.value, checked = target.checked;
      capture(); switchChainToGraph();
      if (step) { if (checked) step.dependsOn.add(id); else step.dependsOn.delete(id); }
      if (cyclic(steps) && step) { step.dependsOn.delete(id); dialog.showError('Эта связь создаёт цикл. Выбери другой шаг.'); }
      render(step?.id, 'details summary'); return;
    }
    if (target.matches('[data-step-tracking], [data-step-optional]')) {
      const row = target.closest('[data-routine-step]'), id = row?.dataset.routineStep;
      capture(); switchChainToGraph(); render(id, 'details summary'); return;
    }
    capture();
  });
  body.addEventListener('input', event => {
    const target = event.target;
    if (target.matches('[data-routine-title]')) title = target.value;
    else if (target.matches('[data-step-title]')) {
      const step = steps.find(item => item.id === target.closest('[data-routine-step]')?.dataset.routineStep);
      if (step) step.title = target.value;
    }
  });
  body.addEventListener('click', event => {
    const button = event.target.closest('button'); if (!button || !body.contains(button)) return;
    if (button.dataset.layout) { setLayout(button.dataset.layout); return; }
    if (button.hasAttribute('data-confirm-collapse')) {
      capture(); savedMultiDraft = cloneSteps(steps); savedMultiMode = mode;
      singleMode = steps[0]?.trackingMode === 'check' ? 'check' : 'activity';
      steps = []; layout = 'single'; mode = singleMode; collapseConfirm = false; render(); return;
    }
    if (button.hasAttribute('data-cancel-collapse')) { collapseConfirm = false; render(); return; }
    if (button.hasAttribute('data-add-step')) { addStep(); return; }
    if (button.dataset.moveStep) {
      capture(); const index = steps.findIndex(step => step.id === button.dataset.stepId), target = index + (button.dataset.moveStep === 'up' ? -1 : 1);
      if (index >= 0 && target >= 0 && target < steps.length) { [steps[index], steps[target]] = [steps[target], steps[index]]; render(button.dataset.stepId); }
      return;
    }
    if (button.dataset.removeStep) {
      capture(); const step = steps.find(item => item.id === button.dataset.removeStep); if (!step) return;
      if (deleteEffects(step).length) { deleteConfirm = step.id; render(step.id); }
      else removeStep(step.id);
      return;
    }
    if (button.dataset.confirmDelete) { capture(); removeStep(button.dataset.confirmDelete); return; }
    if (button.hasAttribute('data-cancel-delete')) { deleteConfirm = null; render(); }
  });

  dialog.form.addEventListener('submit', async () => {
    if (dialog.pending) return;
    capture();
    if (!title.trim() || title.trim().length > 160) { dialog.showError('Название должно содержать от 1 до 160 символов.', body.querySelector('[data-routine-title]')); return; }
    if (layout === 'multi' && (!steps.length || steps.length > 50 || steps.some(step => !step.title.trim() || step.title.trim().length > 160))) { dialog.showError('Добавь от 1 до 50 шагов и заполни их названия.'); return; }
    if (layout === 'multi' && cyclic(steps)) { dialog.showError('Проверь связи: шаги не должны образовывать цикл.'); return; }
    const savedMode = currentKind === 'rule' ? 'check' : layout === 'single' ? singleMode : mode;
    const graphSteps = steps.map(step => ({ title: step.title.trim(), dependsOn: [...step.dependsOn].map(id => steps.findIndex(candidate => candidate.id === id)).filter(index => index >= 0).sort((a, b) => a - b), trackingMode: step.trackingMode, optional: step.optional }));
    const fields = { kind: currentKind, title: title.trim(), weekdays, startsOn, endsOn, time, active, required, mode: savedMode, steps: layout === 'multi' ? (savedMode === 'chain' ? steps.map(step => ({ title: step.title.trim() })) : graphSteps) : [] };
    dialog.setPending(true); dialog.showError('');
    try {
      const result = await store.savePlan(fields, plan?.id, { expectedPlan: expectedPlan || undefined });
      onSaved(result.state); document.defaultView.dispatchEvent(new document.defaultView.CustomEvent('hanni:recurring-changed'));
      dialog.setPending(false); dialog.close();
    } catch (error) { dialog.setPending(false); dialog.showError(error?.message || String(error)); }
  });
  dialog.form.addEventListener('keydown', event => { if (event.key === 'Enter' && event.target.matches('input:not([type=checkbox]):not([type=date]):not([type=time])')) event.preventDefault(); });
  render(); dialog.open(body.querySelector('[data-routine-title]')); return dialog;
}

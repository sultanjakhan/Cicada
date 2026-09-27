export const isDigitalActivity = record => record?.source === 'activity_watch';

function duration(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 'нет данных';
  const seconds = Math.floor(value);
  if (value > 0 && seconds === 0) return 'менее 1 с';
  if (seconds < 60) return `${seconds} с`;
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60);
  return [hours && `${hours} ч`, minutes && `${minutes} мин`].filter(Boolean).join(' ');
}

export function appendDigitalActivityDetails(container, record, { onManageHistory }={}) {
  const document = container.ownerDocument, summary = record.activity_summary || {};
  const section = document.createElement('section');
  section.className = 'digital-activity-details';
  const totals = document.createElement('p');
  totals.textContent = `Приложения на экране: ${duration(summary.foreground_seconds)}. Без статуса AFK: ${duration(summary.active_seconds)}.`;
  const meaning = document.createElement('p');
  meaning.className = 'digital-activity-details__hint';
  meaning.textContent = 'Это время приложений на переднем плане. Оно не измеряет внимание или восстановление. AFK — сигнал длительного простоя ввода.';
  section.append(totals, meaning);
  const apps = Object.entries(summary.apps || {}).filter(([, seconds]) => typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (apps.length) {
    const table = document.createElement('table'), head = document.createElement('thead'), heading = document.createElement('tr'), body = document.createElement('tbody');
    for (const label of ['Приложение', 'На экране']) {
      const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = label; heading.append(cell);
    }
    head.append(heading);
    for (const [app, seconds] of apps) {
      const row = document.createElement('tr'), name = document.createElement('td'), time = document.createElement('td');
      name.textContent = app; time.textContent = duration(seconds); row.append(name, time); body.append(row);
    }
    table.append(head, body); section.append(table);
  }
  const identity=String(record.source_id||record.id||'').match(/^digital-activity:([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}):\d{4}-\d{2}-\d{2}$/);
  if(identity&&onManageHistory){
    const button=document.createElement('button');button.type='button';button.textContent='Управлять историей устройства';
    button.addEventListener('click',()=>onManageHistory({id:identity[1],label:record.title||'Устройство из дневного итога'}));
    section.append(button);
  }
  container.append(section);
}

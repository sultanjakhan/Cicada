// Presentation only: preserve the recorded enum and observation freshness.
const statuses = { planned: 'Запланировано', running: 'В работе', waiting: 'Ожидание', checking: 'Проверка', 'decision-needed': 'Нужно решение', done: 'Готово', error: 'Ошибка', cancelled: 'Отменено', unknown: 'Неизвестно' };
const observations = { fresh: 'Свежее наблюдение', stale: 'Устаревшее наблюдение', unknown: 'Свежесть неизвестна' };
export const registryStatusLabel = status => statuses[status] ?? statuses.unknown;
export const registryFreshnessLabel = freshness => observations[freshness] ?? observations.unknown;

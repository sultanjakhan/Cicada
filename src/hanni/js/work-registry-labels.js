import { copyForLanguage } from './ui-copy.js';
// Presentation only: preserve the recorded enum and observation freshness.
const statuses = { planned: 'Запланировано', running: 'В работе', waiting: 'Ожидание', checking: 'Проверка', 'decision-needed': 'Нужно решение', done: 'Готово', error: 'Ошибка', cancelled: 'Отменено', unknown: 'Неизвестно' };
const observations = { fresh: 'Свежее наблюдение', stale: 'Устаревшее наблюдение', unknown: 'Свежесть неизвестна' };
export const registryStatusLabel = (status, language = 'ru') => copyForLanguage(language)(statuses[status] ?? statuses.unknown);
export const registryFreshnessLabel = (freshness, language = 'ru') => copyForLanguage(language)(observations[freshness] ?? observations.unknown);

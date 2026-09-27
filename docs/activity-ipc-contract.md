# Импорт цифровой активности: IPC-контракт

Контракт для настроек «Ограничения» и календаря. Импорт выключен в новом профиле; команды не возвращают токены, URL окон, заголовки, скриншоты, package/classname или сырые записи.

## Команды

- `digital_activity_get_connections()` → `{ enabled, devices: [...] }`
- `digital_activity_save_connection(input)` → `DigitalActivityConnectionStatus` (токен принимается только при сохранении и никогда не возвращается)
- `digital_activity_import_now(device_id?: string, local_date?: string)` → `{ imported, changed, skipped, errors, days }`
- `digital_activity_status()` → `{ enabled, devices: [...] }`

Поля устройства: `id`, `label`, `source` (`activitywatch`), `endpoint` (loopback only), `port`, `enabled`, `capabilities`, `lastSuccess`, `lastError`, `records`. Секреты и HTTP-ответы наружу не попадают.

## Данные календаря

На каждое устройство и локальный день создаётся или обновляется одно обычное событие `Активность · <label> · <duration>`. Теги содержат только стабильный источник, device id и день. Повторный импорт с теми же агрегатами не меняет `version`/`updated_at`. Суммарные минуты не превращаются в непрерывный интервал. В заметке — названия приложений и длительности, без URL и заголовков.

## Приватность и ошибки

Клиент принимает только `127.0.0.1`/`localhost`, использует короткий timeout, отключает прокси и редиректы и ограничивает размер ответа. Windows-запись с неотфильтрованным `title` отвергается; Android принимает только `app`/`package` после нормализации и выбрасывает остальные поля. Ошибка устройства не создаёт пустое событие и не сообщает об успешном импорте.

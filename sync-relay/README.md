# Hanni MVP encrypted relay

Перенос транспорта существующего Hanni: Cloudflare Worker, SQLite Durable Object,
монотонный журнал, точное повторение ACK и native WebSocket. Worker принимает
непрозрачные XChaCha20-Poly1305 envelopes; ключ расшифрования остаётся у клиентов.
Сервер не проверяет внутреннюю схему данных или корректность AEAD. Проверка
профиля `hanni-mvp-content-v1`, расшифрование и объединение выполняются в MVP.

## Изоляция

`wrangler.jsonc` задаёт новый Worker `hanni-mvp-relay-v1`, собственный DO namespace
класса `Relay` и migration tag `hanni-mvp-v1`. Внутри namespace используется только
фиксированное имя объекта `hanni-mvp-relay-v1`. Существующие Hanni Worker, данные,
токены, ключи и endpoint не используются.

Публичный allowlist содержит только:

- `POST /content/v1/batches` — сохранить пакет или повторить его ACK.
- `GET /content/v1/batches?after=N&limit=16` — получить следующие пакеты.
- `GET /content/v1/device-state` — ACK и client sequence своего устройства.
- `GET /content/v1/stream` — native WebSocket с заголовком Authorization.

`/v1/*`, другие профили, content checkpoint и maintenance возвращают 404.
Сохранён проверенный внутренний Relay engine Hanni; его checkpoint API не открыт
через router MVP. В MVP нет автоматической публикации checkpoint или очистки
журнала. Протокол: [CONTRACT.md](CONTRACT.md).

## Локальное создание конфигураций

Требуется Node 22+ на Mac/Linux. Генерация на Windows намеренно недоступна:
Unix modes Node не обеспечивают Windows ACL. Полученные JSON подходят также
Windows-клиенту; генерация не требует запущенного ПК или телефона.

```sh
node tools/provision.mjs \
  --endpoint https://hanni-mvp-relay-v1.your-subdomain.workers.dev/ \
  --output-dir /absolute/private/directory/new-pairing \
  --devices mac,windows,phone
```

Endpoint — HTTPS origin отдельного MVP Worker, без `/content`, query или токенов.
Генератор принимает только `hanni-mvp-relay-v1.<subdomain>.workers.dev`, чтобы
случайно не направить новые credentials на legacy. До появления собственного
домена используется адрес Workers.dev.

Родитель output directory должен существовать вне любого Git repository.
Генератор разрешает symlink родителя и проверяет реальные ancestors, в том числе
`.git`-файлы worktree. Сам output directory обязан быть новым: существующий
каталог, файл или symlink не перезаписывается. Новый каталог имеет mode 0700,
каждый файл — 0600. Файлы создаются через exclusive write. При I/O ошибке уже
созданные файлы сохраняются; частичный набор нельзя использовать для подключения.

Создаются `device-mac.json`, `device-windows.json`, `device-phone.json` с разными
random device IDs и 32-byte bearer tokens, общим новым 32-byte ключом и key ID.
`worker-secrets.json` содержит только binding `HANNI_DEVICE_TOKEN_HASHES`:
строку JSON `device_id -> SHA256(token_string)`, без plaintext tokens и ключа.
CLI выводит только профиль, число устройств и имена файлов. Не передавайте
ключи/токены через аргументы команд и не включайте конфигурации в Git.

Каждому устройству передаётся только предназначенный ему файл через частный
канал, затем файл импортируется native MVP. Не запускайте генератор заново для
уже подключённой группы: новый ключ создаст другую группу. Повторная установка
приложения должна сохранить его рабочую БД и per-device configuration, включая
client sequence; восстановление одним старым config-файлом не сбрасывает сервер.
Добавление или отзыв устройства требует отдельного изменения набора hashes.

Генератор работает полностью локально: не вызывает Wrangler, Cloudflare API,
Keychain или существующее приложение. `worker-secrets.json` имеет формат для
Wrangler `secret bulk`, но публикация Worker и установка binding выполняются
отдельно. Наличие исходников и configs не доказывает, что relay опубликован.

## Пределы и сохранность

| Ресурс | Предел этого Worker |
| --- | ---: |
| HTTP body / ciphertext с tag | 96 KiB / 64 KiB |
| Pull page | 32 записи, около 512 KiB |
| Content-журнал | 128 MiB / 100000 сохранённых пакетов |
| Физическая SQLite БД | 768 MiB |
| Авторизованные запросы в UTC сутки | 15000 |
| Новые пакеты / учтённые bytes в UTC сутки | 4000 / 256 MiB |
| Устройств / WebSockets на устройство | 8 / 2 |

Лимит хранения учитывает размер canonical envelope и накладные bytes, а не
размер JSON пользовательской записи. Повторный ACK не добавляет пакет.
429 возвращает `Retry-After`; 507 `relay_capacity_reached` останавливает новые
записи, сохраняя принятый журнал. Клиент сохраняет outbox и показывает ошибку.
После исчерпания storage capacity обычное ожидание не освобождает место:
**у content v1 нет GC/checkpoint, поэтому журнал не рассчитан на неограниченную
долгосрочную работу**. До достижения предела потребуется отдельно проверенное
расширение протокола. Удалять DO, сбрасывать cursor или outbox для обхода лимита
нельзя: это создаёт риск потери и расхождения данных.

ACK и уведомления отправляются после SQLite transaction и `storage.sync()`.
Каждое устройство сохраняет собственный `client_seq` и повторяет точный ciphertext
при потере ACK. Ошибка cursor/sequence не признаётся успешной синхронизацией.
Ни runtime, ни provisioning не записывают tokens, ключи, ciphertext или raw errors
в журналы; Cloudflare observability отключена в конфигурации.

## Воспроизводимая локальная проверка

Зависимости закреплены lockfile: Wrangler 4.129.0, Miniflare
5.20260903.0-alpha, workerd 1.20260903.1. `node_modules` и локальное Wrangler
состояние игнорируются. Работайте из временной копии/отдельного worktree MVP.

```sh
npm ci --no-audit --no-fund
npm test
npm run test:native
```

`npm test` запускает настоящий локальный workerd/SQLite: изоляцию маршрутов,
авторизацию, идемпотентность и потерю ACK, независимые sequence устройств,
пагинацию, limits, восстановление runtime, WebSocket и безопасный provisioning.
Persistent fixtures создаются в системном temporary directory; все данные
синтетические. Опциональный `HANNI_MINIFLARE_MODULE` задаёт локальный module URL
установленного Miniflare, если зависимости вынесены в отдельный tooling directory.

`npm run test:native` создаёт три синтетические конфигурации `mac.json`,
`windows.json`, `phone.json` вне Git, запускает Miniflare и loopback HTTP bridge,
затем `cargo test --locked mvp_sync_local_relay_roundtrip -- --ignored` из
`src-tauri/Cargo.toml`. `HANNI_MVP_TEST_RELAY_CONFIG_DIR` указывает на fixtures;
`HANNI_MVP_DATA_DIR` изолирует native данные. Native допускает loopback HTTP только
в тесте, публичный Worker сохраняет HTTPS-only проверку. После завершения
`finally` закрывает listener и вызывает `mf.dispose()`. На успешном запуске
выводится только `native_relay_roundtrip_passed`; raw native assertion output
подавляется, поскольку может содержать credentials. Fixtures остаются в tmp.

Эти проверки не доказывают работу установленного телефона/Windows, фоновые
ограничения мобильной ОС или доступность публичного deployment.

Основания: [Wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/),
[локальная разработка](https://developers.cloudflare.com/workers/local-development/),
[SQLite Durable Objects](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).

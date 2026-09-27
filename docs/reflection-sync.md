# Reflection sync: isolated canonical records

Канонические вопросы и ответы хранятся в `ui_state.calendar_reflections_v1` и отдельных `mvp_records` существующего зашифрованного content sync. SQL-схема, relay и ключи шифрования не меняются. Обычный старый writer `calendar_recurring_v1` не владеет этими записями.

## IPC

- `recurring_get_bundle()` → `{recurring: string|null, reflections: string|null}`. Миграция inline и чтение обеих строк происходят в одной транзакции.
- `recurring_save_bundle({value, expectedRecurring, expectedReflections, reflectionChange})` → тот же bundle. `value` — сериализованное recurring-состояние; оба expected — точные строки предыдущего bundle (для null передать `""`). CAS и обе записи атомарны. Устаревшая строка даёт `mvp_sync_stale_ui_state`, без частичного сохранения.
- `reflectionChange: null` означает обычное изменение расписания/статуса, без изменения владельца вопроса/ответа.
- `{kind:"plan", id, prompt:string|null}` явно меняет вопрос. Поле prompt обязательно; null выключает будущие вопросы, сохраняя историю.
- `{kind:"answer", id, date, answer:{ruleOutcome, restoration, trigger}}` сохраняет ответ. Допустимые ответы: `kept|broken|no_answer` и `better|same|worse|no_answer`. Вопрос ≤160 символов, trigger ≤500, id ≤128 байт; даты и соответствие snapshot проверяет native. Будущие ответы запрещены.
- Generic `set_ui_state` для sidecar отклоняется: `reflection_use_bundle_command`. Bundle-save удаляет inline reflection из recurring plan/day/snapshot.

## Записи и миграция

Sidecar v1 содержит maps `plans[id]` и `days[date][id]`:

- plan: `{legacy:boolean, enabled:boolean, prompt:string|null}`;
- day: `{legacy:boolean, prompt:string, snapshot:planWithoutReflection, status:"pending"|"done"|"skipped", answer:object|null}`.

Native startup/get мигрируют имеющиеся inline-значения транзакционно и идемпотентно; входящие старые routine records также могут создать отсутствующий seed. Seed помечен `legacy:true`. Любая явно написанная запись (`legacy:false`) и tombstone доминируют seed независимо от timestamp, порядка доставки и clock skew. Среди seeds вариант с ответом выше варианта без ответа. Между двумя authored-записями остаётся существующий алгоритм sync и архив конфликтов. Существующая запись не меняет payload под прежним stamp: новое содержимое получает новую версию. Известный sidecar/tombstone никогда не заменяется поздней inline-миграцией, в том числе при conflict resolution и checkpoint restore.

Исторический вопрос и snapshot фиксируются при первом сохранении дня. Изменение вопроса и explicit disable не переписывают их. Frontend накладывает sidecar после чтения recurring. Если старый writer потерял день, история доступна из sidecar с `_reflectionOnly`; обычный следующий save не восстанавливает такой день в recurring автоматически. Явная отметка статуса может восстановить день. Удалённый план в список расписаний не возвращается.

## Проверки и границы

Rust: реальный native IPC MockRuntime, CAS обоих ключей и rollback журнала/данных, повторная миграция, old setStatus/edit, три SQLite-реплики с перестановкой сообщений и tombstone, настоящий зашифрованный durable outbox после upgrade, encrypted checkpoint restore, разрешение конфликтов. JS: новый bundle IPC без fallback, explicit intent, наложение sidecar, восстановление истории и существующие UI-сценарии.

Это защита сохранности данных для новых клиентов. Старый клиент может остановить входящий sync на неизвестном ui-key и продолжить отправлять свою очередь. Двусторонняя совместимость старого клиента не заявлена; перед production rollout нужны согласованные минимальные версии получателей. Проверки SQLite/IPC/jsdom не доказывают доставку на физический Android/Mac или native UI: это отдельная приёмка интегратора. Удаление рефлексии отдельным пользовательским действием в этот этап не входит.

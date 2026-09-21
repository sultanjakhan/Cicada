# Продолжение на Mac — 21.09.2026

Ветка `work/execution-ux-20260920-8bf4` содержит весь принятый кандидат: изменения
важности задач, Today и фоновой синхронизации из checkpoint `078a61f`, затем
прямой запуск задач, занятия и цепочки рутин, возврат к работе и компактные цели.
Последний проверенный коммит кода — `97076988689743722da0b248f0ffa8b7391c396a`;
следующий коммит добавляет только эту передачу. Кандидат ещё не объединён с main
и не является установленным релизом.

## Получить точную рабочую копию

Для нового каталога:

```sh
git clone --single-branch --branch work/execution-ux-20260920-8bf4 \
  https://github.com/sultanjakhan/hanni-mvp.git hanni-execution
cd hanni-execution
git status --short --branch
git log -2 --oneline
```

Если репозиторий уже есть, сначала проверь `git status` и `git remote -v`.
Сохрани незавершённую работу; не выполняй reset/clean и не накатывай старую
историю до очистки open-source репозитория. В чистом совместимом checkout:

```sh
git fetch origin
git switch --track origin/work/execution-ux-20260920-8bf4
```

Если такая локальная ветка уже существует, переключись на неё после проверки
WIP и используй `git pull --ff-only`. Для новых параллельных изменений выдели
свой worktree по AGENTS.md. Задай собственный уникальный `HANNI_SESSION_ID`.
Windows-сессия после публикации этот кандидат больше не меняет; чужие ветки
и legacy Hanni остаются под своими правилами владения.

## Проверки и запуск

На Windows при коде `9707698`: 232 JavaScript-теста, 117 Rust-тестов прошли,
4 Rust-теста были ignored; vendor/privacy guards и native debug build прошли.
В настоящем окне Windows DEV проверены запуск/пауза, цепочка шагов, возврат,
перезапуск, цель с 71 навыком, фильтр этапа, поиск и редактирование.
Это не проверка macOS или физического Android.

После установки зависимостей из [macOS build](macos-build.md):

```sh
npm ci
npm test
npm run check:vendor
python3 -B scripts/check-private-data.py
```

Для проверки интерфейса используй отдельный debug-профиль:

```sh
HANNI_MVP_DATA_DIR="$HOME/Library/Application Support/Hanni-MVP-Execution-DEV" \
  npm run tauri -- dev
```

Он стартует с пустыми данными. Личные базы, ключи, веса моделей и Windows
проверочная сборка в Git не входят. Не копируй идентичность синхронизации
между одновременно работающими устройствами. Release-сборка игнорирует
`HANNI_MVP_DATA_DIR`; её подготовка описана отдельно в macOS build.

## Следующее действие

Принять основные сценарии на Mac и решить интеграцию с актуальным main.
Разработческие задачи и подробная Windows-приёмка остаются в существующем
GitHub Issues, без отдельного backlog в этом файле. Источник skills и адаптеров
моделей — Agent City, инструкция `agent-system/MAC-SETUP.md` в его репозитории.

# Календарь звонков (продолжение)

[![hexlet-check](https://github.com/ignateff/ai-for-developers-project-387/actions/workflows/hexlet-check.yml/badge.svg)](https://github.com/ignateff/ai-for-developers-project-387/actions)
[![CI](https://github.com/ignateff/ai-for-developers-project-387/actions/workflows/ci.yml/badge.svg)](https://github.com/ignateff/ai-for-developers-project-387/actions/workflows/ci.yml)

Продолжение проекта [«Календарь звонков»](https://github.com/ignateff/ai-for-developers-project-386): интеграция работы агентов в GitHub. Владелец создаёт типы встреч и просматривает предстоящие записи; гость без регистрации выбирает свободный слот и записывается на звонок.

Один владелец задан заранее. Авторизации, личных кабинетов и интеграций с внешними календарями нет. Календарь показывает ближайшие 14 календарных дней. Встречи не могут пересекаться даже частично, в том числе между разными типами встреч и при одновременных запросах. Не используйте реальные персональные данные в учебном демо.

Учебный проект Хекслета: https://ru.hexlet.io/programs/ai-for-developers
Как это должно работать: https://files.hexlet.app/a/2ipc5m

## Приложение

Работающий адрес из предыдущего проекта: **https://call-calendar-k7f2.fly.dev/**.
Проверено 3 ноября 2026: главная страница и `/api/health` вернули HTTP 200 (`{"status":"ok"}`). Это прежний деплой, а не автоматическая публикация кода из нового репозитория; доступность зависит от Fly.io и биллинга.

SQLite на Fly.io хранится в постоянном томе `/data`: обычный перезапуск и деплой сохраняют данные, удаление тома — нет. Локально разные папки проекта используют отдельные базы. В Docker без подключённого тома данные теряются при удалении контейнера.

Если публичный адрес недоступен, наставник может запустить приложение командами ниже — через mise или Docker.

## Стек

- TypeScript, Fastify, React, Vite, Mantine, SQLite и Drizzle.
- TypeSpec → OpenAPI → Orval SDK; frontend обращается к API через сгенерированный SDK.
- Vitest, Testing Library, Playwright, Oxlint, Oxfmt, mise, hk и GitHub Actions.

### Устройство проекта

- `apps/api/` — API и база данных; `apps/web/` — frontend.
- `contract/` — TypeSpec; `generated/` — OpenAPI и SDK (`mise run generate`).
- `e2e/` — браузерные и визуальные тесты; `scripts/` — проверки и инструменты разработки.
- `AGENTS.md`, [docs/agents/](docs/agents/README.md) — инструкции, трекер и настройки скиллов.
- [GLOSSARY.md](GLOSSARY.md) — словарь; [docs/adr/](docs/adr/) — архитектурные решения.
- [Исходные спецификации и решения](docs/agents/project-history.md) — ссылки на требования и историю первого проекта. Исторические ссылки ведут в `386`, новые задачи — в [трекер `387`](https://github.com/ignateff/ai-for-developers-project-387/issues).

## Установка

Установите [mise](https://mise.jdx.dev/getting-started.html), затем:

```bash
git clone https://github.com/ignateff/ai-for-developers-project-387.git
cd ai-for-developers-project-387
mise trust
mise install
mise run install
```

Переменные окружения для локальной разработки не требуются. Git-хуки устанавливаются отдельно: `mise run install-hooks`.

## Использование

```bash
mise run dev         # запустить API и frontend, вывести адрес
mise daemons ls      # состояние серверов
mise daemons stop    # остановить серверы этой папки
```

По умолчанию frontend доступен на http://localhost:5173, API — на http://localhost:3000. Если порт занят, выбирается следующий свободный; фактический адрес выводится при запуске. Для явного выбора: `PORT=3100 WEB_PORT=5180 mise run dev`. Занятый явно заданный порт вызывает ошибку. `API_PROXY_TARGET` задаёт адрес API для frontend-прокси.

Для запуска в двух терминалах на переднем плане: `mise run dev-api` и `mise run dev-web`.

### Запуск через Docker

Нужен работающий Docker; mise и Node.js на хосте для этого варианта не требуются:

```bash
docker build --build-arg APP_REVISION="$(git rev-parse HEAD)" -t call-calendar .
docker volume create call-calendar-data
docker run --rm --name call-calendar -p 8080:8080 \
  -e PORT=8080 -e DATABASE_PATH=/data/calendar.sqlite \
  -v call-calendar-data:/data call-calendar
```

Откройте http://localhost:8080. Проверка API: `curl http://localhost:8080/api/health`. Том сохраняет записи между запусками контейнера.

### Проверки

```bash
mise run test:e2e:install  # установить Chromium один раз
mise run check            # полный набор, как в CI; нужен работающий Docker
mise run check:quick      # lint, форматирование, типы
mise run test             # Vitest
mise run test:e2e         # Playwright, включая визуальные проверки
```

Полная проверка также сверяет генерацию контракта/SDK, собирает приложение, проверяет workflows и запускает production Docker smoke. Правила и ограничения: [docs/agents/testing.md](docs/agents/testing.md).

При конфликте портов тестов: `E2E_API_PORT=3320 E2E_WEB_PORT=5320 mise run check`.

### Автоматический предварительный триаж

Workflow `.github/workflows/opencode-triage.yml` запускается при открытии issue, если он включён в GitHub Actions. Он проверяет автора: владелец или участник с правами `admin` или `write`; при ошибке проверки запуск пропускается. Закреплённый обработчик OpenCode не поддерживает роль `maintain` в своей проверке доступа. Боты и issue с метками `ready-for-agent`, `ready-for-human` или `wontfix` пропускаются. Автоматические тикеты, созданные ботом, не требуют повторного разбора.

Агент читает обращение и код, оставляет предварительный разбор и вопросы; он не согласует поведение и не реализует задачу. Ответы автора не запускают повторный триаж автоматически: используйте `/oc` в комментарии. Результаты и пропуски проверяются в Actions и в самом issue. Workflow ограничен 15 минутами и общей очередью последовательных запусков.

Права workflow — `contents: read` и `issues: write`. Последнее разрешение действует на **все** issue репозитория, а не только на текущее; prompt и настройки инструментов не являются полной защитой от недоверенного текста. Проверяйте ответы агента. Метки проверяются при открытии и повторно перед запуском агента: если метку добавили после проверки, возможна гонка. Подготовленные тикеты следует создавать от бота или сразу с меткой; поздняя установка метки не гарантирует пропуск.

### Независимое ревью PR

Авторевью остаётся отключённым и не готово к включению: сбор полного контекста и реальная публикация ещё не подтверждены. Изменение настроек GitHub, включение workflow и реальные вызовы модели требуют отдельного разрешения. Локальные тесты с подменами не доказывают публикацию или права токенов. Ревью консультативно и не является обязательным статусом мержа; решение принимает человек после проверки CI и доказательств.

Целевые события — `opened`, `synchronize`, `reopened`, `ready_for_review`; draft пропускается только автоматическим ревью, а явные команды доверенного человека `/oc` в обоих каналах draft PR допускаются. Изменение описания (`edited`) модель не запускает: повтор после изменения контекста инициирует человек. Для каждого PR предусмотрены независимые бюджеты 3 командные попытки и 3 попытки ревью; это best effort, не строгий предел расходов. Доверие, права, действия при сбоях и ручное восстановление счётчика описаны в [операционной инструкции](docs/opencode-review.md) и [инструкции по бюджету](docs/agents/pr-attempt-budget.md).

### Версия и публикация

В консоли браузера приложение один раз выводит `Calendar v<version> (<revision>)`; версия берётся из `version.txt`, ревизия — из коммита сборки. В dev добавляется `[dev]`, без переданного build argument ревизия Docker будет `unknown`. Это версия загруженного frontend, не подтверждение версии backend или успешного деплоя.

`mise run build:docker` собирает образ с текущей ревизией. `mise run deploy:prepare` готовит локальный образ `linux/amd64`, ничего не публикуя; требуется чистый `main`, синхронизированный с `origin/main`. Деплой — отдельная явно согласованная операция по [fly-deploy](.agents/skills/fly-deploy/SKILL.md). Перенесённый `fly.toml` относится к прежнему приложению: сам перенос не разрешает его обновление.

Настройка Release Please: [docs/release.md](docs/release.md). GitHub App и его секреты не копируются между репозиториями; до настройки App workflow выпуска пропускается, CI и Hexlet продолжают работать.

---

<details>
<summary>Автоматические тесты Хекслета</summary>

Тесты запускаются на каждый коммит. За запуск отвечает файл `.github/workflows/hexlet-check.yml` — не удаляйте и не переименовывайте ни его, ни репозиторий.

</details>

## О Хекслете

[Хекслет](https://ru.hexlet.io/) — школа программирования: авторские программы обучения с практикой, поддержкой наставников и реальными проектами, которые остаются в резюме. Этот репозиторий — один из таких проектов.

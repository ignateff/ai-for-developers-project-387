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

Для PR отдельное задание `head-browser` проверяет сценарии записи, копирования деталей и загрузки предстоящих событий из точного head SHA и сохраняет результат и Playwright trace в артефакте `head-browser-<SHA>`. Перед мержем откройте артефакт, проверьте результат и сверьте SHA с текущим head; после нового push проверку нужно повторить. Для других доработок сценарии необходимо сверять с согласованной спецификацией.

В защите `main` обязательна успешная проверка GitHub Actions `check`, включая для администраторов. Браузерный артефакт `head-browser` проверяется человеком отдельно.

При конфликте портов тестов: `E2E_API_PORT=3320 E2E_WEB_PORT=5320 mise run check`.

### Команды GitHub-агента

Workflow `.github/workflows/opencode.yml` запускается по новому комментарию в issue, общему комментарию в PR или комментарию к строке diff. Классификатор принимает команды `/oc` и `/opencode`; далее проверяются права автора и происхождение PR. Доступны владелец и участники с правами `write`, `maintain` или `admin`; команды ботов и PR из fork отклоняются. Команды для одного issue или PR выполняются последовательно. Задача ограничена 150 минутами, из которых на работу агента отведено до 120 минут.

Пользовательские объяснения агент пишет по-русски; обязательные сообщения коммитов остаются на английском в формате Conventional Commits. Адаптер использует OpenCode GitHub App с OIDC и модель, выбранную переменной репозитория `OPENCODE_MODEL`; по умолчанию это `opencode-go/deepseek-v4.1-flash` провайдера OpenCode Go с ключом из GitHub Secret `OPENCODE_API_KEY`. Если переменная не задана, используется это же значение по умолчанию; поддерживаемые провайдеры, формат, секреты и смена модели описаны в [docs/opencode-models.md](docs/opencode-models.md). Вместо стандартной установки через composite Action используется закреплённая версия CLI с проверкой целостности и дополнительными проверками доступа. Публикация сеанса отключена: `share: disabled` и `SHARE=false`. Checkout не сохраняет credentials. Подробнее о правах, ограничениях и диагностике — в [docs/opencode-commands.md](docs/opencode-commands.md).

Агент может отвечать на вопросы и готовить изменения или задачи. Например, в [issue № 26](https://github.com/ignateff/ai-for-developers-project-387/issues/26#issuecomment-6665575831) он перечислил доступные скиллы со ссылкой на прогон. Результат команды и проверки созданного PR необходимо проверять отдельно.

Для диагностики включён вывод stdout и stderr обработчика в публичный лог Actions. Он может содержать чувствительные данные, в том числе учётные данные; ограничения и способ отключения описаны в [docs/opencode-commands.md](docs/opencode-commands.md#publication-risk).

### Учебный цикл

В [обращении № 108](https://github.com/ignateff/ai-for-developers-project-387/issues/108) агент разобрал поведение кнопки «Повторить», а владелец [согласовал требования](https://github.com/ignateff/ai-for-developers-project-387/issues/108#issuecomment-6821926290). Агент оформил [спецификацию № 109](https://github.com/ignateff/ai-for-developers-project-387/issues/109) через `to-spec` и после [согласования разбиения](https://github.com/ignateff/ai-for-developers-project-387/issues/109#issuecomment-6822013501) создал [тикет № 110](https://github.com/ignateff/ai-for-developers-project-387/issues/110) через `to-tickets`. Запуск `implement-spec` создал [PR № 111](https://github.com/ignateff/ai-for-developers-project-387/pull/111).

- **Общий комментарий.** В PR № 111 агент по [команде владельца](https://github.com/ignateff/ai-for-developers-project-387/pull/111#issuecomment-6823155089) внёс и опубликовал [правку кода](https://github.com/ignateff/ai-for-developers-project-387/commit/8469b80463de647c6c1ce274a4290f6897ca9dbe).
- **Комментарий к строке diff.** В PR № 98 [независимое ревью](https://github.com/ignateff/ai-for-developers-project-387/pull/98#issuecomment-6772832520) обнаружило, что форма теряет введённую тему звонка. Владелец передал замечание [командой к строке](https://github.com/ignateff/ai-for-developers-project-387/pull/98#discussion_r4527629168), агент опубликовал [исправление и регрессионные тесты](https://github.com/ignateff/ai-for-developers-project-387/commit/f194201811492271b0ae443e8cc2bdddbce9c81d). PR № 98 закрыт без мержа.
- **Сбой публикации.** В PR № 111 [команда к строке](https://github.com/ignateff/ai-for-developers-project-387/pull/111#discussion_r4550357559) запустила агента, но [push упал при авторизации](https://github.com/ignateff/ai-for-developers-project-387/actions/runs/43217274263/job/131179638823). Исправление гонки в тестовой Docker-заглушке было восстановлено вручную в коммите `9cc018d`.
- **Приёмка PR № 111.** [CI](https://github.com/ignateff/ai-for-developers-project-387/actions/runs/43586882902) и [независимое ревью](https://github.com/ignateff/ai-for-developers-project-387/pull/111#issuecomment-6876184113) завершились для `451f436`. Владелец сверил [браузерный артефакт](https://github.com/ignateff/ai-for-developers-project-387/actions/runs/43586882902/artifacts/14110623586) с head и подтвердил результат перед мержем. В описании PR зафиксированы контрольный отказ без блокировки кнопки, успешный прогон с исправлением, риск и откат.
- **После мержа.** Изменение вошло в `main` как [`d29dce0`](https://github.com/ignateff/ai-for-developers-project-387/commit/d29dce09321f6ac587029b1e0b2ebad1572f6626). Запуски на этом коммите: [CI](https://github.com/ignateff/ai-for-developers-project-387/actions/runs/43587435009) и [hexlet-check](https://github.com/ignateff/ai-for-developers-project-387/actions/runs/43587435015). Release Please открыл [PR № 112 для версии 0.11.1](https://github.com/ignateff/ai-for-developers-project-387/pull/112).

### Самооценка

Триаж и авторевью в моей работе показали себя стабильно. Считаю их полезной практикой. С правками по комментариям пока сложнее: воркфлоу зависают, их трудно отлаживать на GitHub Runner, а повторные запуски расходуют токены модели.

### Автоматический предварительный триаж

Workflow `.github/workflows/opencode-triage.yml` запускается при открытии issue, если он включён в GitHub Actions. Он проверяет автора: владелец или участник с правами `admin` или `write`; при ошибке проверки запуск пропускается. Закреплённый обработчик OpenCode не поддерживает роль `maintain` в своей проверке доступа. Боты и issue с метками `ready-for-agent`, `ready-for-human` или `wontfix` пропускаются. Автоматические тикеты, созданные ботом, не требуют повторного разбора.

Агент читает обращение и код, оставляет предварительный разбор и вопросы на русском языке; он не согласует поведение и не реализует задачу. Ответ начинается с явной пометки `> *Сгенерировано ИИ в ходе триажа.*`. Ответы автора не запускают повторный триаж автоматически: используйте `/oc` в комментарии. Результаты и пропуски проверяются в Actions и в самом issue. Workflow ограничен 15 минутами и общей очередью последовательных запусков.

Права workflow — `contents: read` и `issues: write`. Последнее разрешение действует на **все** issue репозитория, а не только на текущее; prompt и настройки инструментов не являются полной защитой от недоверенного текста. Проверяйте ответы агента. Метки проверяются при открытии и повторно перед запуском агента: если метку добавили после проверки, возможна гонка. Подготовленные тикеты следует создавать от бота или сразу с меткой; поздняя установка метки не гарантирует пропуск.

### Независимое ревью PR

Workflow авторевью работает в основной ветке. Например, [ревью PR № 71](https://github.com/ignateff/ai-for-developers-project-387/pull/71#issuecomment-6722122479) опубликовало замечание со ссылкой на прогон и SHA; это исторический пример, в котором полные снимки исходников были недоступны. Текущий сборщик получает деревья base/head и выбранные неизменённые связанные файлы: зависимости изменённого кода, импортёры, тесты, контракт/OpenAPI/SDK. Адаптер дополнительно кладёт их в `repository/` изолированного workspace, чтобы ревьюер искал и читал связанные код, тесты и контракты read-only инструментами; сокращение или недоступность контекста явно попадает в ограничения отчёта. Полный репозиторий в снимок не копируется. Отчёт и ограничения публикуются на русском языке. Успешная публикация не подтверждает полноту проверки или завершение всего учебного цикла. Ревью консультативно и не является обязательным статусом мержа; решение принимает человек после проверки CI и доказательств.

Критерии из [REVIEW.md](REVIEW.md) загружаются из базового коммита PR; недоступный файл отмечается как ограничение. Целевые события — `opened`, `synchronize`, `reopened`, `ready_for_review`; draft пропускается только автоматическим ревью, а явные команды доверенного человека `/oc` в обоих каналах draft PR допускаются. Изменение описания (`edited`) модель не запускает: повтор после изменения контекста инициирует человек. Результат ревью содержит проверенный head SHA; CI и прежние замечания собираются для этого SHA, а список коммитов PR позволяет связать прежние замечания с последующими исправлениями. Незавершённые или недоступные проверки не считаются успешными. Для каждого PR предусмотрены независимые бюджеты: три команды по истории Actions и три попытки ревью по прежнему счётчику; это best effort, не строгий предел расходов. История команд до перехода на v2 не учитывается. Доверие, права, действия при сбоях и ручное восстановление счётчика описаны в [операционной инструкции](docs/opencode-review.md) и [инструкции по бюджету](docs/agents/pr-attempt-budget.md). [Ревью PR № 111](https://github.com/ignateff/ai-for-developers-project-387/pull/111#issuecomment-6876184113) показывает результат и ограничения расширенного контекста. [Четвёртый вызов в PR № 98](https://github.com/ignateff/ai-for-developers-project-387/pull/98#issuecomment-6774874448) получил `limit_exhausted` до запуска модели.

### Аудит производительности по расписанию

Workflow `.github/workflows/scheduled-performance-audit.yml` запускает Lighthouse ежедневно в 17:07 по Москве (14:07 UTC) и вручную через Actions. Адрес берётся из `app_url`, переменной репозитория `APP_URL` или указанного в workflow адреса. Модель берётся из общей переменной `OPENCODE_MODEL` (по умолчанию `opencode-go/deepseek-v4.1-flash`); для анализа нужен секрет выбранного провайдера — `OPENCODE_API_KEY` или `DEEPSEEK_API_KEY`. Агент использует `GITHUB_TOKEN` с правами на issue. Тайм-аут — 20 минут, параллельные аудиты ограничены. Настройка модели описана в [docs/opencode-models.md](docs/opencode-models.md).

JSON-отчёт сохраняется артефактом `lighthouse-report`, а агент должен опубликовать результат в issue или комментарии и создать отдельную задачу только для новой находки. Задачи, комментарии и итоговые сообщения агент пишет по-русски; названия метрик `LCP`, `CLS` и `INP` и технические идентификаторы сохраняются. Ссылка на прогон связывает вывод с артефактом; артефакты хранятся ограниченное время. Отчёты в `.audit/` игнорируются Git. Для проверки создания задачи ручной запуск с `training: true` использует синтетический отчёт: соответствующий issue учебный и не подтверждает дефект приложения. Учебная задача всегда ищется по точному заголовку `[TRAINING] Lighthouse LCP example`, включая закрытые задачи, поэтому русский текст ответа не создаёт дубликат. Лабораторный Lighthouse не измеряет INP.

[Ручной запуск на main](https://github.com/ignateff/ai-for-developers-project-387/actions/runs/42778112405) сохранил [отчёт Lighthouse](https://github.com/ignateff/ai-for-developers-project-387/actions/runs/42778112405/artifacts/13744358683) и [вывод агента](https://github.com/ignateff/ai-for-developers-project-387/issues/77#issuecomment-6762027882). Аудит проверял прежний деплой приложения. В [следующем плановом прогоне](https://github.com/ignateff/ai-for-developers-project-387/actions/runs/43505416179) агент также [не нашёл отклонений](https://github.com/ignateff/ai-for-developers-project-387/issues/77#issuecomment-6864652064).

[Учебный запуск](https://github.com/ignateff/ai-for-developers-project-387/actions/runs/42400137780/job/128485925607) создал issue № 56 по синтетической находке. [Повторный запуск](https://github.com/ignateff/ai-for-developers-project-387/actions/runs/42400239693/job/128486233750) нашёл существующую задачу и не создал дубль. Issue № 56 впоследствии удалён; оба результата сохранились в логах Actions.

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

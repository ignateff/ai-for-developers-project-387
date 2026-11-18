# Automatic tests

After completing all the steps in the project, automatic tests will become available to you. Tests are run on each commit - once all tasks in the Hexlet interface are completed, make a commit, and the tests will run automatically.

The hexlet-check.yml file is responsible for running these tests - do not delete this file, edit it, or rename the repository.

## Agentic workflow smoke test

Run **Agentic workflow smoke test** from the Actions tab after the workflow is on the default branch. The workflow uses Claude Code with DeepSeek Flash and the existing `DEEPSEEK_API_KEY` Actions secret. The run summary should contain `call-calendar` and `vitest run`, read from the root `package.json`.

Update [agentic-smoke.md](agentic-smoke.md) and regenerate the lock file with gh-aw v1.2.2:

```sh
gh aw compile agentic-smoke
mise run format
mise run lint:workflows
```

## Предварительный триаж задач (gh-aw)

[Триаж](agentic-triage.md) запускается при открытии задачи и публикует один комментарий с предварительным анализом. Он использует Claude Code с моделью `deepseek-v4.1-flash` через OpenCode Go и секретом Actions `OPENCODE_API_KEY`. Для ручной проверки передайте номер issue, созданного владельцем или участником с правом записи. Задачи ботов и задачи с метками `ready-for-agent`, `ready-for-human` или `wontfix` пропускаются.

Для [OpenCode Go в Claude Code](https://opencode.ai/docs/console/harnesses/claude-code/#go) используется адрес `https://opencode.ai/inference/go/anthropic`. В этом workflow ключ поступает в прокси AWF через `ANTHROPIC_API_KEY` с префиксом `Bearer `, а `AWF_ANTHROPIC_AUTH_HEADER: Authorization` задаёт заголовок для отправки провайдеру. AWF принимает статические credentials через `ANTHROPIC_API_KEY` и передаёт значение пользовательского заголовка целиком. [Аутентификация AWF](https://github.com/github/gh-aw-firewall/blob/main/docs/auth-matrix.md)

```sh
gh workflow run agentic-triage.lock.yml --ref main -f issue_number=123
```

Результат смотрите в комментариях задачи и Summary выбранного запуска. Для обновления конфигурации используйте gh-aw v1.2.2 и компилируйте оба workflow при изменении [общего шага установки Claude Code](shared/claude-code-install.md).

```sh
gh aw compile agentic-smoke agentic-triage --strict
mise run format
mise run lint:workflows
```

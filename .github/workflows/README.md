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

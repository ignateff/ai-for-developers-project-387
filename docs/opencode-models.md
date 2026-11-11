# OpenCode model configuration

All working OpenCode workflows select their model from one repository variable:
**`OPENCODE_MODEL`**. The value is resolved by `scripts/opencode-model.ts`; no
workflow or adapter carries its own fallback model.

## Where the setting lives

- Variable name: `OPENCODE_MODEL`
- Location: GitHub repository **Settings → Secrets and variables → Actions →
  Variables → New repository variable**
- CLI: `gh variable set OPENCODE_MODEL --body "provider/model"`

The variable is not a secret. Do not put provider keys or other credentials in
it.

## Default

When the variable is unset or empty, every applicable workflow uses:

```text
opencode-go/deepseek-v4.1-flash
```

That default is defined only in `scripts/opencode-model.ts`. Workflows pass
`OPENCODE_MODEL: ${{ vars.OPENCODE_MODEL }}`; the scripts substitute the default
after reading the environment.

## Format

The value must be exactly one `provider/model` pair:

```text
provider/model
```

The provider and model parts use lowercase letters, digits, `.`, `_` and `-`,
start with a letter or digit, and the whole value is at most 100 characters.
For example:

```text
opencode-go/deepseek-v4.1-flash
deepseek/deepseek-flash
```

Leading and trailing whitespace is ignored. Any other value is rejected before
OpenCode starts. The value is never inserted into a shell command: it is read
from the environment, validated, and passed to the pinned CLI through the
`MODEL` environment variable or the `--model` argument array.

## Credentials

| Provider      | Required secret    | Current default model             |
| ------------- | ------------------ | --------------------------------- |
| `opencode-go` | `OPENCODE_API_KEY` | `opencode-go/deepseek-v4.1-flash` |
| `deepseek`    | `DEEPSEEK_API_KEY` | `deepseek/deepseek-flash`         |

Every model-capable workflow step receives both repository secrets so that
switching between these two providers needs only the variable. The scripts
forward **only the credential for the selected provider** to the OpenCode process
and remove the other one. Preparation and publication/reporting steps still run
without provider credentials.

If the selected provider's secret is missing, the run fails before the model is
invoked with a message that names the missing secret. No secret value is printed.

## What happens if the value is invalid

Validation happens in the trusted setup path and fails closed:

- Command preparation and the command model check reject the value before
  runtime preparation or a model call.
- Review resolves it after authorization and admission, before installing the
  runtime or calling the model. The failure follows the normal infrastructure
  path: `review.json` and the `report`/`number`/`sha` outputs are created, so the
  separately authorized publication step still reports the failed review.
- Triage and performance-audit launchers reject it before spawning OpenCode.
- Unsupported providers are rejected; the supported providers are the two in
  the table above.

The error includes a generic format description and never echoes the configured
value, so a malformed or hostile value cannot inject shell syntax or leak into
logs.

## Workflows that use the setting

| Workflow                       | Path through the setting                              |
| ------------------------------ | ----------------------------------------------------- |
| Commands `/oc` and `/opencode` | `createCommandEnvironment` → `MODEL`                  |
| Automatic pull-request review  | `opencode:budget review` → review adapter → `--model` |
| New-issue triage               | `scripts/opencode-launch.ts … github run` → `MODEL`   |
| Scheduled performance audit    | `scripts/opencode-launch.ts … run` → `--model`        |
| Manual performance check       | `scripts/opencode-launch.ts … run` → `--model`        |

The handler diagnostic (`opencode-diagnostic.yml`) intentionally does **not** use
`OPENCODE_MODEL`. It is a bounded read-only diagnostic pinned to
`opencode/big-pickle` and does not receive production provider credentials, so a
model change cannot alter that diagnostic or make it depend on a paid provider.

## Changing the model

1. Choose a supported provider and model that accepts tool calls.
2. Make sure the matching repository secret exists (`OPENCODE_API_KEY` or
   `DEEPSEEK_API_KEY`).
3. Set the variable, for example:

   ```bash
   gh variable set OPENCODE_MODEL --body "deepseek/deepseek-flash"
   ```

4. Trigger a low-risk model path after merge: for example, open a disposable
   test issue for triage or run `/oc` with a read-only question on a test issue.
   A scheduled or manual performance audit is also acceptable when its issue
   output is expected.

## Verifying the result after merge

- Confirm the variable: `gh variable list`.
- In the workflow log, find the safe line `OpenCode model: <provider/model>`.
  It appears during command preparation/model check, review preparation after
  admission, and the triage and audit launcher steps.
- Confirm the log does not contain either provider key.
- Confirm the workflow reached its normal result. A model that does not exist,
  lacks access, or does not support tool calls fails at the provider and is
  reported as an agent/infrastructure failure; the repository cannot validate
  model availability ahead of time.

## Limitations when switching providers

- Only providers with an explicit mapping in `scripts/opencode-model.ts` are
  supported. A different provider requires a code change that adds its
  credential variable, plus a repository secret and the secret reference in each
  model-capable workflow. It cannot be enabled by the variable alone.
- The setting changes the model, not trust or permissions. Authorization,
  attempt budgets, isolation, publication permissions and workflow timeouts are
  unchanged.
- The model must support the tool-calling and context behavior the commands,
  review, triage and audits rely on. A model with a smaller context or weaker
  tool support can fail or produce lower-quality results.
- Provider quotas, model retirement and API outages remain external failures.
- Diagnostic and fixture providers stay pinned (`opencode/big-pickle` and the
  local `fixture/fixture` provider in runtime tests); tests never call the real
  selected model.

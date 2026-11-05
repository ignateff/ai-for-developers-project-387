# GitHub command execution

Scope: [issue #9](https://github.com/ignateff/ai-for-developers-project-387/issues/9).
Only `.github/workflows/opencode.yml` is involved. Automatic PR review and issue
triage remain separate and unchanged.

## Trust boundary

The workflow bootstraps its scripts from the repository's default branch, not the
commented PR. Before starting the agent, a preflight checks the original comment
author against repository permissions. The owner and users with write, maintain,
or admin access are eligible; comment association alone is not authorization.
Missing data and API failures reject the command. Fork PRs are rejected even when
the commenter is trusted.

Preparation also inspects the internal PR's current tree through the GitHub API,
not merely the default-branch bootstrap. The pinned runtime has a second plugin
discovery path which ignores its V1 disable flags. Consequently repository
`.opencode` directories and configuration containing plugins, agent/permission
overrides or experimental configuration fail closed before runtime startup.
Configuration inspection accepts strict JSON only; commented JSONC fails closed
instead of being partially parsed. V1 project configuration is disabled for the
command process.
This gate checks the source snapshot at startup, not future edits by trusted code.

Trusted same-repository code and its checks run with credentials available. This
is intentionally **not an OS or filesystem sandbox**. OpenCode permission checks
do not inspect all filesystem accesses made inside shell commands, Node, mise,
or tests. Do not use this workflow to execute untrusted code.

## Runtime and delivery

The local adapter retains upstream `opencode github run`, App/OIDC token exchange,
and `deepseek/deepseek-flash`. It replaces the floating installation performed by
the upstream composite Action. The pinned CLI must be verified before the handler
starts; a version-specific cache key alone is insufficient.

The handler creates a branch and PR for issue commands. For comments on an
existing internal PR it updates that PR instead of creating another one. The
handler's ability to publish does not establish that checks passed: inspect the
resulting checks and require successful CI before merge.

Preparation runs without provider credentials. Only the final agent step receives
the provider key. Never print full resolved configuration, environment variables,
Git credential configuration, or raw authorization/API error payloads.

Upstream stdout/stderr are not forwarded verbatim: its dynamically exchanged App
token is unknown to the parent and may occur in encoded Git-error arguments.
Only an exact allowlist of fixed phase messages is relayed; all other output is
discarded, including error annotations and model text. The handler still publishes
its normal response on the issue/PR. A cancellation remains a failure even if the
child exits with code zero after receiving the signal.

HOME, XDG state and TMPDIR/TMP/TEMP are dedicated to the run. Mise's installed
tool directory is retained explicitly, without copying developer configuration
or credentials. The short run-directory name leaves room for the homedir-based
Unix sockets used by project lifecycle tests.

## Noninteractive policy

Unanswered `ask` requests can wait forever in the pinned GitHub handler. An outer
job timeout limits cost, but is not the fix. Preparation must validate the actual
resolved permissions before execution: defaults and agent overrides matter, not
just the supplied JSON. Invalid configuration must fail rather than silently use
defaults.

The command agent must have no effective `ask` rules. Interactive questions,
subagents, plan transitions and doom-loop approval are disabled. Detected access
outside the checkout, dedicated temporary directory and explicitly justified
tool paths is rejected without waiting. A blanket `/tmp/*` allowance is not used.
Changing TMPDIR does not redirect hard-coded paths or `homedir()`; the environment
and tests must account for those separately.

## Limits and queue

The command job has a 30-minute limit. Failure, cancellation and timeout are not
successful fixes, and partial output is not evidence of completion.

Commands for one issue/PR are serialized without cancelling the active run.
GitHub's `queue: max` permits up to 100 pending runs; additional runs are cancelled
when full. FIFO order follows entry into concurrency waiting, not necessarily
comment timestamps. Different issues/PRs may execute concurrently.

## Verification and authorization

Use the project's mise tasks for local checks. Permission regression must exercise
the pinned runtime without real model or GitHub credentials and distinguish a
pending request from immediate allow/deny. `debug agent --tool` alone cannot prove
this: this version's debug tool path does not wait on `ask`.

```sh
mise run test -- scripts/opencode-command.test.ts scripts/opencode-trust.test.ts
mise run test:opencode-runtime
mise run lint:opencode-workflow
mise run check
```

The real-runtime regression is included in `mise run check`. It downloads the
pinned public release and checks its archive and executable SHA256 before use.
For an offline run, `CALENDAR_OPENCODE_ARCHIVE=/absolute/path/to/the/release/archive`
can supply the public artifact instead; the same hard-coded checksum is mandatory.
It never selects a PATH binary or uses model/GitHub credentials. Each run extracts
a fresh executable; production installation has no floating runtime cache.

Local tests cannot prove that the App accepts OIDC from the adapted workflow or
that a real issue-to-PR run succeeds. Publishing changes and running a controlled
GitHub test require separate authorization. Until that test is performed, keep
the end-to-end acceptance criterion open; do not close issue #9 merely because
local checks pass. Do not merge into the default branch merely to obtain a test.

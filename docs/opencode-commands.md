# GitHub command execution

Scope: [issue #9](https://github.com/ignateff/ai-for-developers-project-387/issues/9).
Only `.github/workflows/opencode.yml` is involved. Automatic PR review and issue
triage remain separate and unchanged.

## Invocation and sharing

The workflow listens for newly created `issue_comment` and
`pull_request_review_comment` events. Its classifier accepts `/oc` and
`/opencode` at a whitespace boundary; the upstream handler and authorization
checks still decide whether the command can run. The command environment sets
`share: "disabled"` and `SHARE=false`; it does not publish shared sessions.

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

The job's `GITHUB_TOKEN` has `issues: write` so authorized commands can publish
specifications and tickets with `gh`. This permission covers all repository
issues, including edits, labels and closure; it is not restricted to creation or
to the triggering issue. All steps in the job can access the job token, and the
agent receives it after the trusted-comment preflight. Issue text and comments
remain untrusted input even when a trusted user invokes the command. Review the
agent's published results; a successful run is not proof of an authorized action.

## Runtime and delivery

The local adapter retains upstream `opencode github run`, App/OIDC token exchange,
and `deepseek/deepseek-flash`. It replaces the floating installation performed by
the upstream composite Action. The pinned CLI must be verified before the handler
starts; a version-specific cache key alone is insufficient. The runtime archive
download is retried a bounded number of times within a fixed time budget; failures
stay generic and never include response bodies or raw errors.

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

After an admitted command, a separate `continue-on-error` step reads the runtime's
own log from the prepared command directory and prints only allowlisted
aggregates. It never prints raw log lines, tool output, prompts or credentials,
reports a missing log as `unavailable`, and runs after failures and timeouts
except cancellation. It does not change the recorded outcome.

The summary distinguishes a model call from a running shell command or a pending
permission request only when the corresponding allowlisted events exist. It also
reports, only when the pinned runtime actually emits them: the session count,
subagent starts with their approved type counts (`implementer`, `reviewer`, other
counted but never named), `task` permission allow/deny decisions, loop
completions, cancellations, error-line count, the longest observed subagent
session in seconds, and whether observation exceeded two concurrent subagents.
Tool decisions are observable only as allowlisted permission names with counts
(`tool_permissions`, fixed tool names only; anything unrecognized is aggregated as
`other`). The runtime does not log a generic tool-execution event, so individual
tool durations and a definitive result stay unknown: the summary prints
`tool_duration=unknown`, `tool_name=unknown`, `result=unknown`, and
`concurrency_enforced=no` instead of inferring them. A truncated log downgrades a
concurrency conclusion to `unknown`. The policy is to publish only counts,
allowlisted fixed names, booleans and durations; prompts, file contents, commands
and arguments, tool output, model text, tokens and secrets are never copied.

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
plan transitions and doom-loop approval are disabled. Delegation is limited to
the two validated subagent types in [Subagent delegation](#subagent-delegation);
every other type is denied. Detected access
outside the checkout, dedicated temporary directory and explicitly justified
tool paths is rejected without waiting. A blanket `/tmp/*` allowance is not used.
Changing TMPDIR does not redirect hard-coded paths or `homedir()`; the environment
and tests must account for those separately.

## Subagent delegation

Issue #83 allows the command agent to delegate through `task`, because
`implement-spec`, `tdd` and `code-review` require subagents. The pinned runtime is
OpenCode 1.19.5; its subagent model is a set of named agents with `mode:
"subagent"` and a `task` permission whose patterns match the requested
`subagent_type`. Preparation and every run resolve and validate all three agents
(`build`, `implementer`, `reviewer`) with `opencode debug agent` and compare the
resolved tail of the policy with the expected rules; an unknown, missing,
interactive or drifted policy fails closed before the handler starts.

Only these types are allowed; the built-in `general`, `explore` and `plan` agents
and any other name are denied by the `task` pattern before the runtime looks the
name up. Denial is immediate — the verification runs and the runtime regression
observe no `permission.asked` event and an empty pending-permission list.

| Type          | Tool schema on the pinned runtime                                                                            | Intended work                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `implementer` | `bash`, `edit`/`write`, `read`, `glob`, `grep`, `todowrite`, `webfetch`, `websearch`, the nine pinned skills | implementation, exploration, tests, merges in the shared checkout      |
| `reviewer`    | `read`, `glob`, `grep` only (1.19.5 has no separate `list` tool)                                             | read-only review, for example the parallel sub-agents of `code-review` |

The reviewer restriction is enforced by its own permission ruleset, not by an
instruction: the editing and shell tools are absent from its tool schema, and
`.env` files, outside-checkout paths, skills, web access and nested delegation
stay denied. The implementer inherits the command agent's editing and shell
capability but not `task`.

Subagents run in the same process, checkout and working directory as the parent
and inherit its environment, including `GH_TOKEN` and the provider key. An
implementer with shell access can therefore read or forward those credentials;
the reviewer cannot execute shell. Treat any delegated implementer as equivalent
to the trusted command agent itself. Git worktrees created inside the checkout
are technically permitted by the shell and external-directory policy, but they
are untracked and the handler publishes the single shared checkout as one branch;
the preparation instruction therefore forbids nested worktrees instead of relying
on a permission boundary.

There is **no hard runtime cap** on parallel subagents on 1.19.5. The runtime has
no semaphore or concurrency setting, the plugin hook that could enforce one is
disabled by `OPENCODE_PURE=1`, and the project configuration remains rejected.
Empirical runs created up to five concurrent child sessions from one assistant
message. The agreement is therefore a target of at most two concurrently running
subagents, backed by two mechanisms that are not enforcement: the preparation
instruction asks the agent to serialize beyond two, and the safe log summary
reports `max_concurrent_subagents` and `concurrency_exceeded` (detecting a breach
after the fact, and reporting `unknown` when the log is missing or truncated). A
run that exceeded two is visible in the summary but was not prevented by the
runtime; do not describe the instruction as a guarantee.

## Limits and queue

The agent has 45 minutes of work inside a 50-minute command step and a 55-minute
job, leaving room for preparation, signal delivery, the safe log summary and
reporting. The attempt budget is unchanged and best effort, not a monetary
ceiling; all subagents run inside the same admitted attempt and do not admit
additional runs.

Cancellation forwards SIGTERM/SIGINT to the whole detached handler process group
and escalates to SIGKILL after a grace period even when the direct handler already
exited, so same-group descendants are still killed. Descendants that deliberately
leave the group (`setsid`, detached) are not guaranteed to be killed; the GitHub
runner's job teardown is the backstop. The escalation is covered by
`scripts/opencode-handler.test.ts`, including a grandchild that ignores SIGTERM.

Failure, cancellation and timeout are not successful fixes, and partial output is
not evidence of completion. When the agent times out, fails or cannot start, a
separate reporting job posts a human-readable reason, the SHA and the run link,
and states explicitly that task completion is not confirmed. A failed comment
publication fails that job instead of looking like a notification. Forced
cancellation or runner loss can still prevent any report; inspect the run.

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
mise run test -- scripts/opencode-command.test.ts scripts/opencode-handler.test.ts scripts/opencode-log-summary.test.ts scripts/opencode-workflow.test.ts scripts/opencode-trust.test.ts
mise run test:opencode-runtime
mise run lint:opencode-workflow
mise run check
```

The real-runtime regression exercises the pinned runtime with a local fixture
provider: subagent resolution and the `task` allow/deny patterns, the
implementer/reviewer permission split, immediate denials with no pending request,
and the safe log summary against a real runtime log. Handler process-group
termination is covered separately by `scripts/opencode-handler.test.ts`; the
workflow's `timeout -> mise -> pnpm -> node` link is covered only by the live run. It downloads the pinned public release and checks
its archive and executable SHA256 before use. For an offline run,
`CALENDAR_OPENCODE_ARCHIVE=/absolute/path/to/the/release/archive` can supply the
public artifact instead; the same hard-coded checksum is mandatory. It never
selects a PATH binary or uses model/GitHub credentials. Each run extracts a fresh
executable; production installation has no floating runtime cache. As of this
writing the runtime regressions are temporarily excluded from `mise run check`
because they can hang; run them separately and report a hang as a blocker rather
than treating the check as green.

Local tests alone cannot prove App/OIDC authorization or GitHub publication.
A real command listed project skills in [issue #26](https://github.com/ignateff/ai-for-developers-project-387/issues/26#issuecomment-6665575831),
and the agreed specification and ticket were published as [#33](https://github.com/ignateff/ai-for-developers-project-387/issues/33)
and [#34](https://github.com/ignateff/ai-for-developers-project-387/issues/34).
These observations do not establish every issue-to-PR or correction scenario.
Check each created issue or PR, its links and actual CI results rather than
relying on an Actions job's success status.

### Controlled live run required by #83

The workflow and the bootstrap scripts come from the default branch, so this
recorded live check is necessarily a post-merge step; a branch run cannot exercise
this workflow.

1. Prepare a small test issue with one verifiable change and a trusted maintainer
   comment `/oc ...`.
2. Confirm admission and preparation succeed, then inspect the run log for the
   fixed handler phases and the safe runtime summary: subagent starts, approved
   type counts, `task_allowed`/`task_denied`, completions/cancellations and
   `concurrency_exceeded`. Confirm the summary never prints prompts, file
   contents, commands, tool output, model text, tokens or secrets.
3. Confirm the published PR or comment and its real CI result; a successful
   handler is delivery, not proof that the change is correct.
4. Separately exercise failure handling: cancel a run, and confirm from the
   runner process list that the handler child group is gone; let a run hit the
   45-minute work limit or force a command failure in a controlled way, and
   confirm the issue/PR receives the truthful not-confirmed outcome with the run
   link. Forced cancellation may prevent the final comment by design.
5. Record the run URLs and outcomes on the issue, then run `mise run check` on the
   final commit. Local and live checks do not substitute for each other; an
   unavailable check or an unverified criterion stays a blocker.

The 45-minute timeout and signal propagation through
`timeout -> mise -> pnpm -> node` are verified locally only for the layers that
can run on this host; the GNU `timeout` link and the real runner path must be
confirmed by the live cancellation run above.

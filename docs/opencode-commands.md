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

**Restored after experiment #90:** the comment triggers for `issue_comment` and
`pull_request_review_comment` were moved back from
`opencode-upstream-experiment.yml`, the experiment workflow was deleted and the
manual `workflow_dispatch` entry point was removed. `scripts/opencode-workflow.test.ts`
asserts that only `opencode.yml` subscribes to these events, so exactly one `/oc`
handler reacts to a comment. The triggers and the two-hour limits below take
effect only after this change merges to the default branch.

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
and the model selected by the repository variable `OPENCODE_MODEL`
(`opencode-go/deepseek-v4.1-flash` when unset). It replaces the floating installation performed by
the upstream composite Action. The pinned CLI must be verified before the handler
starts; a version-specific cache key alone is insufficient. The runtime archive
download is retried a bounded number of times within a fixed time budget; failures
stay generic and never include response bodies or raw errors. See
[OpenCode model configuration](opencode-models.md) for supported providers,
credentials and switching.

The handler creates a branch and PR for issue commands. For comments on an
existing internal PR it updates that PR instead of creating another one. The
handler's ability to publish does not establish that checks passed: inspect the
resulting checks and require successful CI before merge.

Preparation runs without provider credentials. Only the final agent step receives
the provider key. The explicitly enabled raw diagnostic output can nevertheless
expose sensitive content, including credentials, in the public Actions log.

The owner explicitly enabled raw upstream stdout and stderr in the public Actions
log for diagnosis. It can include prompts, file contents, commands, error payloads,
and dynamically exchanged App credentials; GitHub masking cannot guarantee their
removal. GitHub workflow command parsing is paused during raw output. A cancelled
handler still reports failure even if the child exits successfully.

### Detailed activity logging

The command process tails the runtime's structured log while the handler runs and
prints allowlisted activity events live; after the run a separate
`continue-on-error` step prints the existing aggregate summary plus an activity
digest and the last safe events. The digest runs after failures and timeouts
except cancellation, reports a missing log as `unavailable`, and does not change
the recorded outcome.

Live activity lines look like `OpenCode activity: event=...` and can show:

- lifecycle stages: fixed handler phases, session start, model request
  (provider, model, agent), loop step, loop end, cancellation;
- which tools ran: allowlisted tool names and the permission decision
  (`allow`/`deny`/`ask`), including subagents requested through `task` and the
  approved subagent type;
- redacted command families for shell permission decisions, for example
  `family="mise run check"`. The first word must be a known command and later
  words must be short lowercase words; quoted values, paths, URLs, flags,
  arguments and mixed-case or digit-heavy tokens stop the summary;
- which checks ran: a command family matching known check commands is counted in
  `checks=`, with the result left unknown (see the compromise below);
- whether a permission request is pending and which one (`event=waiting_permission
  permission=...`), which explains a run that appears stuck;
- path categories (`relative_path`, `absolute_path`, `wildcard`) rather than the
  path itself, and error occurrence with `details=withheld`.

The digest reports counts (`events`, `tools`, `command_families`, `checks`,
`subagents_started`, `subagent_ends`, `permission_waits`, `waiting_on`, `errors`)
and the last up-to-20 safe events, so the activity immediately before an error or
timeout is visible without exporting raw output. The older summary counters and
the subagent/concurrency observations remain in the same output line.

The post-run step streams the whole log in bounded chunks instead of reading a
fixed prefix: counters cover every line and the digest keeps only the last safe
events, so a large log cannot push the cause of a stop out of the window. A single
line is capped (1 MiB); longer lines are skipped and counted as
`oversized_lines` with their content withheld. For files above 256 MiB the tail is
read instead and `truncated=yes` marks the partial window. Live activity tailing
also keeps memory bounded.

### Publication risk

The raw output is public and may disclose secrets and other sensitive data. The
structured activity summary remains best-effort; it does not establish that the
raw stream is redacted or complete. OpenCode may also write data to separate
files or buffer its output, so live output is limited to what the handler sends
to stdout and stderr. To restore filtered-only output, remove `OPENCODE_RAW_OUTPUT`
from the command step in `.github/workflows/opencode.yml`.

Do not treat the structured activity log as proof that checks passed or that the
task is complete.

### Commit message policy

The pinned runtime 1.19.5 does not use the final response verbatim as the commit
message. After the agent stops, `opencode github run` calls its `summarize`
helper: a second model request asks for a summary of the final response in fewer
than 40 characters. When uncommitted changes remain, the handler runs
`git add .` and `git commit -m <summary>`; when the agent already committed all
changes, the handler pushes those commits without adding another one. This was
verified against the pinned release binary (OpenCode 1.19.5, source commit
`810c0eb`), including its embedded handler code, not inferred from the final
response wording.

The prepared `instructions.md` therefore requires the agent to:

- write every commit message in English with a Conventional Commits 1.0.0
  header, without a trailing period;
- add a `Refs: #<issue>` footer using the issue number from the task context and
  never invent one;
- commit its own changes and leave the working tree clean before the final
  response;
- begin the final response with a valid Conventional Commits header and the
  `Refs` footer, because the handler may still summarize it for a fallback
  commit.

This instruction reduces the risk of `check:commits` failing, but it is not a
guarantee. The fallback summary can be shortened, translated or punctuated by
the model, and an agent that ignores the instruction or leaves uncommitted
changes can still produce a non-conforming upstream commit. The publication
mechanism, permissions and attempt budget are unchanged, and no commit check is
disabled.

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
to the trusted command agent itself.

`implement-spec` needs one worktree per implementer and merge subagents, so the
preparation instruction allows each implementer a separate git worktree and
branch under TMPDIR (outside the checkout). The worktree must be merged back into
this checkout's branch, and the worktree and temporary branch removed, before the
final response, because the upstream handler publishes only this checkout.
Worktrees are a shell-level mechanism, not an enforced sandbox: the residual risk
is that an implementer leaves an unmerged branch or an unclean worktree, so review
the resulting PR and its commits instead of trusting the agent's report.

There is **no hard runtime cap** on parallel subagents on 1.19.5. The runtime has
no semaphore or concurrency setting, the plugin hook that could enforce one is
disabled by `OPENCODE_PURE=1`, and the project configuration remains rejected.
Empirical runs created up to five concurrent child sessions from one assistant
message. The agreement is therefore a target of at most two concurrently running
subagents, backed by two mechanisms that are not enforcement: the preparation
instruction asks the agent to keep at most two running at any time (further
subagents may run sequentially), and the safe log summary reports an observed
lower bound with a breach flag. The flag is `yes` only when a breach was observed,
`no` only when no subagent session started, and `unknown` otherwise, because loop
completion is provisional. A run that exceeded two is visible in the summary but
was not prevented by the runtime; do not describe the instruction as a guarantee.

## Limits and queue

The agent has 2 hours of work. The nested limits are: 120 minutes for the
`timeout`-wrapped agent command inside a 130-minute command step, a 6-minute
preparation step and a 5-minute activity/log summary step inside a 150-minute
job. The 10-minute step margin covers the `--kill-after=10s` escalation and
wrapper exit; the job keeps a further 9-minute margin over preparation, the
command step and diagnostics for classification before it ends. The separate reporting job
has its own 5-minute limit. GitHub's maximum job duration is 6 hours, so the
limits stay well inside it. A timeout is reported as an unconfirmed task, never
as success. The attempt budget is unchanged and best effort, not a monetary
ceiling; all subagents run inside the same admitted attempt and do not admit
additional runs.

Cancellation forwards SIGTERM/SIGINT to the whole detached handler process group
and escalates to SIGKILL after a grace period even when the direct handler already
exited, so same-group descendants are still killed. The referenced escalation
timer keeps the wrapper process alive until it fires; a standalone-process test
covers that lifecycle, not just the in-process unit path. Descendants that
deliberately leave the group (`setsid`, detached) are not guaranteed to be killed;
the GitHub runner's job teardown is the backstop.

Failure, cancellation and timeout are not successful fixes, and partial output is
not evidence of completion. When the agent times out, fails or cannot start, a
separate reporting job posts a human-readable reason, the SHA and the run link,
and states explicitly that task completion is not confirmed. It comments on the
triggering issue or pull request using the event target, so ordinary issue
commands are reported too even though they have no admission PR; the job has
`issues: write` and `pull-requests: write` and no model credentials. A failed
comment publication fails that job instead of looking like a notification.
Untrusted or skipped admissions stay silent. Forced cancellation or runner loss
can still prevent any report; inspect the run.

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
mise run test -- scripts/opencode-activity.test.ts scripts/opencode-command.test.ts scripts/opencode-handler.test.ts scripts/opencode-log-summary.test.ts scripts/opencode-workflow.test.ts scripts/opencode-trust.test.ts
mise run test:opencode-runtime
mise run lint:opencode-workflow
mise run check
```

The real-runtime regression exercises the pinned runtime with a local fixture
provider: subagent resolution and the `task` allow/deny patterns, the
implementer/reviewer permission split, immediate denials with no pending request,
an implementer worktree under TMPDIR that is merged, removed and cleaned up, and
the safe log summary plus activity digest against a real runtime log. The
activity parser has separate unit tests for tool events, command families,
permission waits, subagent start/end, error withholding and the live tail.
Handler process-group
termination, including the standalone-process escalation lifecycle, is covered by
`scripts/opencode-handler.test.ts`; the workflow's `timeout -> mise -> pnpm ->
node` link is covered only by the live run. It downloads the pinned public release and checks
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
this workflow. After merge, confirm that exactly one `/oc` handler reacts to a
command comment, then run the checks below on a trusted test issue.

1. Prepare a small test issue with one verifiable change and a trusted maintainer
   comment `/oc ...`.
2. Confirm admission and preparation succeed, then inspect the run log for the
   fixed handler phases and the live `OpenCode activity:` lines: stages, tool
   names and decisions, redacted command families, `task` subagent starts/ends and
   `waiting_permission`. Then inspect the post-run summary and activity digest:
   subagent starts/types, `task_allowed`/`task_denied`, `checks`,
   completions/cancellations, `concurrency_exceeded` and the last events.
   Confirm handler stdout and stderr arrive during execution; their raw contents
   are public and may include sensitive data.
3. Confirm the published PR or comment and its real CI result; a successful
   handler is delivery, not proof that the change is correct.
4. Separately exercise failure handling: cancel a run, and confirm from the
   runner process list that the handler child group is gone; let a run hit the
   2-hour work limit or force a command failure in a controlled way, and confirm
   the issue/PR receives the truthful not-confirmed outcome with the run link and
   that the activity log shows the last events before the timeout. Forced
   cancellation may prevent the final comment by design.
5. Record the run URLs and outcomes on the issue, then run `mise run check` on the
   final commit. Local and live checks do not substitute for each other; an
   unavailable check or an unverified criterion stays a blocker.

The 2-hour timeout and signal propagation through
`timeout -> mise -> pnpm -> node` are verified locally only for the layers that
can run on this host; the GNU `timeout` link and the real runner path must be
confirmed by the live cancellation run above.

# OpenCode 1.19.5 subagent runtime spike (issue #83)

Evidence from the pinned OpenCode `1.19.5` (upstream commit `810c0eb`). Method:
checksum-verified release binary plus an OpenAI-compatible fixture provider on
`127.0.0.1` only, isolated `HOME`/`XDG_*` and a fixture workspace. No real
model, GitHub token, Actions run or external service was used; no credential
value is recorded here.

```sh
node scripts/opencode-install.ts /tmp/oc-spike/runtime   # checksum-verified 1.19.5
/tmp/oc-spike/opencode debug agent build                 # also general, explore, implementer, reviewer
node /tmp/oc-spike/harness.mjs                           # delegation/deny/parallel fixture dialogue
node /tmp/oc-spike/q6.mjs                                # termination and signal-forwarding tests
```

The harness imports a snapshot of `createCommandEnvironment`/`commandSubagents`
from `scripts/`; raw evidence is in `/tmp/oc-spike/result.json` and
`/tmp/oc-spike/q6.json`. The fixture harnesses are not committed.

## Q1 Agent and subagent types — PASS

`opencode debug agent <name>` resolves `build` as mode=primary/native,
`general`/`explore` as mode=subagent/native and config-defined
`implementer`/`reviewer` as mode=subagent/native=false, so such agents are
valid `task` types. `permission.task` `{ "*": "deny", implementer: "allow",
reviewer: "allow" }` resolves to the effective tail `deny *`, `allow
implementer`, `allow reviewer` (merged `config.permission` and
`agent.build.permission`; last match wins), and the model-facing task
description advertises only `implementer` and `reviewer`.

Empirical: one parent assistant message with five `task` calls created five
child sessions concurrently; each records `parentID` and the right `agent`, and
completed task parts carry `metadata.sessionId`/`metadata.parentSessionId`.
`subagent_type: "general"` (valid built-in but not allowlisted) and
`"not-a-real-agent"` both failed immediately as a tool error (`The user has
specified a rule which prevents you from using this specific tool call`),
created no child session and produced no permission request. The check runs
before agent lookup, so an unknown type is a permission denial, not `Unknown
agent type`; the `deny *` tail never falls through to an interactive ask.

## Q2 Implementer/reviewer permission split — PASS

Parent `build` session, fixture provider, one message with five `task` calls:
one `implementer`, four `reviewer` variants.

- Implementer: `edit` completed (file changed on disk) and `bash` completed.
  Schema offered: `bash`, `edit`, `write`, `read`, `glob`, `grep`, `todowrite`,
  `webfetch`, `skill`.
- Reviewer: `read` of a project file completed. Overrides on the shared allow
  policy deny `bash`, `edit`, `todowrite`, `webfetch`, `websearch`, `skill`,
  `task`, `question`; schema offered: `glob`, `grep`, `read` only. 1.19.5 has
  no separate `list` tool (directory reads use `read`), so `list` is inert.
- Reviewer `.env` read: immediate tool error from the `read` rule
  `*.env: deny`, no pending request. Reviewer read outside the workspace:
  immediate `external_directory` denial even though `read` is allowed.
- Reviewer attempts to call `edit`, `bash` or nested `task` fail immediately
  with `Model tried to call unavailable tool ... Available tools: glob, grep,
  read`, because hard-denied tools are removed from the model schema.
- Neither subagent can delegate: `task` is absent from both schemas (a default
  `task` deny is appended when the ruleset has no task rule), and resolved
  `subagent_depth: 1` is defense in depth.
- Across all scenarios: zero `permission.asked` events, `GET /permission` empty
  before and after, so denials are immediate and never interactive.

## Q3 Environment and credential inheritance — PASS with residual risk

The implementer shell ran in the same canonical workspace `cwd` as the parent
and observed both `GH_TOKEN` and `DEEPSEEK_API_KEY` as present (a `-n` test
only; no value was read or recorded). Reviewer has no shell tool, so it cannot
execute commands; its external-directory rules remain limited to the workspace
and the command runtime directory, and an outside path was denied.

Residual risk: any allowlisted subagent with shell access inherits the full
command environment, including credentials, so a misbehaving or prompt-injected
implementer can read and exfiltrate them. Reviewer being read-only is not a
credential boundary (it can read non-`.env` files); the barriers are model
instructions, no shell, and post-hoc log review.

## Q4 Concurrency — PASS: there is no hard limit of 2

`packages/opencode/src/tool/task.ts` creates one session per `task` call and has
no semaphore, queue or concurrency setting; the only related config key is
`subagent_depth`, and no `OPENCODE_*` flag caps concurrency (background
subagents are a separate experimental feature).

Empirical: one assistant message with three parallel `task` calls produced three
simultaneously open child sessions (max via `GET /session` polling = 3) and
three concurrent in-flight child model requests (fixture delayed each 800 ms;
scenario 902 ms). No two-slot cap exists.

A plugin gate is unavailable under the production command environment:
`OPENCODE_PURE=1` makes the plugin loader use an empty list and project config
is disabled, so a hook would need trusted configuration changes. Model
instructions ("at most two subagents") are guidance, not a guarantee; this
branch therefore adds detection (counting child sessions/concurrency from the
log or `/event`) rather than enforcement.

## Q5 Diagnostics from the isolated runtime log — PARTIAL

Log: `$OPENCODE_COMMAND_DIR/home/.local/share/opencode/log/opencode.log`
(INFO; the file logger is asynchronous). Events with fields:

| Event                                                      | Fields                                                                                          | Use                                              |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `message=created`                                          | `id`, `parentID`, `agent`, `title` (`(@X subagent)`), `permission`, `time.created`, `directory` | subagent type, task start, session id, parent    |
| `message=stream`, `message=loop`, `message="exiting loop"` | `session.id`, `providerID`, `modelID`, `agent`, `mode`, `step`                                  | per-session model call and loop boundaries       |
| `message=evaluated`                                        | `permission`, `pattern`, `action.permission`, `action.pattern`, `action.action`                 | task type allow/deny decisions                   |
| `message=asking`                                           | `id`, `permission`, `patterns`                                                                  | present only when a permission prompt is pending |
| `message="subtask execution failed"`                       | error, agent, description (source)                                                              | failure logging only, no success counterpart     |

Safe allowlisted lines from the fixture run (other fields elided): `message=evaluated
permission=task pattern=implementer ... action.action=allow` and `message=evaluated
permission=task pattern=general ... action.action=deny`; the `message=asking`
count was 0, matching the absence of interactive requests.

Not available from the file log: tool name/arguments (no `Tool.execute` span
output at INFO), duration fields, and definitive per-task outcome. There is no
task-start/task-end pair with status; `message="exiting loop"` carries only a
session id. Tool name, outcome and start/end times exist only in `/event`
(`session.created` info with `parentID`, `message.part.updated` tool parts with
`state.status`/`state.time`, `session.idle`) or the session API. A summary can
count subagent starts/types and task allow/deny but cannot attribute tool calls
or durations per subagent.

Flush caveat: an immediate read after the final prompt missed 4 of 12
`exiting loop` events (177 lines); after a 2 s flush the same run had 190 lines
and 12 of 12. Read after process exit or wait for flush; SIGKILL can lose the
tail.

## Q6 Termination — PASS locally, one link UNVERIFIED

Harness: a wrapper calls `runGitHubHandler` with a stub handler that spawns a
grandchild (same process group by default, `detached` when escaping).

- PASS: SIGTERM forwards to the whole detached group. With handler and
  grandchild ignoring SIGTERM, SIGKILL escalation fires after ~5.3 s, both die,
  and the wrapper rejects with `OpenCode GitHub handler failed or was cancelled;
  fix is not confirmed`; SIGINT kills both in ~0.3 s. Repo handler unit tests
  cover the same detached-group TERM -> SIGKILL escalation.
- PASS: a child that exits 0 on SIGTERM still yields rejection, not success,
  because cancellation is sticky.
- GAP found in this spike and fixed during implementation (commit `27e7e54`):
  the SIGKILL grace timer used to be cleared when the direct handler child
  closed, so a SIGTERM-ignoring grandchild survived if the handler exited. The
  handler now keeps the escalation armed until the group is empty and probes
  group liveness first; `scripts/opencode-handler.test.ts` covers that case.
  Residual: a grandchild that calls `setsid`/detaches leaves the group and is
  not guaranteed to be killed; GitHub job teardown is the backstop.
- PASS (chain part 1): temp `mise run -> pnpm run -> node handler -> detached
  stub + grandchild`; SIGTERM sent to the `mise` PID alone reached the node
  handler, which ran its cancellation path (rejection recorded, `mise` exit 1,
  chain node and stub dead), so `mise -> pnpm -> node` forwarding works here.
- UNVERIFIED: GNU `timeout` itself is not installed on this macOS host (no BSD
  fallback either), so `timeout --signal=TERM --kill-after=10s 45m mise run
  opencode:run` -> `mise` delivery, 124/137 mapping and Linux mise/pnpm
  signaling need a post-merge controlled Actions cancellation run.

## Q7 Limitations and post-merge checks

- Fixture model only: tool choice and instruction adherence were scripted, so a
  real model may ignore the split or run more parallel tasks. `websearch` was
  hidden with the fixture provider (upstream enables it only for some
  providers/flags), so its allow may be inert in production; `skill` is visible
  to the implementer only for allowlisted skill names and was not exercised.
- A hidden tool yields a generic "unavailable tool" error, so the model cannot
  distinguish a policy-denied call from a malformed one; only permission log
  lines identify allowlist decisions.
- Log parsing is pinned-version-specific and the logger is asynchronous;
  trailing lines can be missing after SIGKILL. No hard concurrency cap exists,
  so diagnostics can only detect overshoot, and secrets remain in the
  implementer environment (Q3).
- Verify after merge in a controlled Actions run: real implementer/reviewer
  behaviour, zero `asking` events, subagent-type and task allow/deny counts,
  `concurrency_exceeded` with three parallel tasks, cancellation/`--kill-after`
  on Linux, and 124/137 timeout mapping.
- Nested worktrees (inference, not exercised end-to-end): shell/`external_directory`
  policy allows paths inside the workspace, so a worktree under the workspace is
  reachable, but the handler publishes a single current branch, so work
  committed only inside a nested worktree is not published; treat nested
  worktrees as scratch/read-only for the handler.

# PR review: operation and local adapter

## Status and authorization

GitHub Actions is enabled for the review workflow, and this branch removes its
local disable guard. Integrate the workflow and trusted base code before expecting
normal operation: the current default branch still has the guard. A controlled
full review timed out; a successful complete review and actual publication of
findings remain unverified. Review is advisory. A human decides after checking CI,
evidence, the current head and each finding.

The reviewer receives `REVIEW.md` from the pinned PR base as context; if it cannot be loaded, the report records an explicit limitation. The PR cannot change its own review criteria.

## Intended operation

The configured PR events are `opened`, `synchronize`, `reopened`, and
`ready_for_review`. Automatic review skips drafts without spending a review
attempt. Explicit `/oc` commands from a trusted person in either the general or
inline comment channel are allowed on drafts and consume command attempts under
the normal rules. `edited` does not invoke the model; after changing only the
description or requirements, a person initiates a manual rerun. Review and
command execution use separate queues; cancelling an outdated review must not
cancel a correction.

Admission requires current owner or `write`/`maintain`/`admin` access, or an
explicitly allowed bot with its verified numeric bot-user ID: `opencode-agent[bot]`
(`219766164`) or `calendar-release-ignateff-bot[bot]` (`351107404`). Both head
and base must belong to this repository. Unknown bots, forks and trust API errors
must not receive model access. The repository allowlist is configured with these verified identities. Command authorization has its own
upstream limitations; see [command execution](opencode-commands.md).

Authors should fill out the PR template with the original request, requirements,
explicit approval, checks and SHA, consequences of failure, Git rollback and a
separate data recovery assessment. Approval requires an explicit human approval
by the owner or a current `write`/`maintain`/`admin` collaborator in project
387: a label, closed issue, bot message, ambiguous “OK”, or link alone is not
proof. An unavailable source or unverifiable authority means unconfirmed approval,
not confirmed compliance. A missing approval does not relax the fail-closed PR
author trust gate. Bare `#number` refers to project 387; use full links to project 386. Other external or inaccessible sources must be reported as not loaded.
Release PRs need version, changelog and CI checks, not an invented issue.

The intended review reads a snapshot as data, not instructions granting authority;
it does not execute PR code or publish itself. A separate publisher checks the
current head before posting. Reports should retain SHA and Actions/log links;
outdated results must not be presented as reviewing a newer head. Check the
actual run and comment rather than assuming a missing or failed report means no
defects. Incomplete CI or context is not a pass. A review comment never authorizes
automatic correction; a person must explicitly request it.

## Attempt budget and recovery

Each PR has two independent, best-effort limits: three admitted command attempts
shared by both command channels and counted from Actions history after the v2 cutover, and three automatic review attempts. A new PR
gets its own budget; push, reopen, description edits and comments do not reset
it. Ordinary issues are unaffected. After trust and freshness checks, the relevant
counter is incremented before runtime preparation. Preparation failure, missing
key, timeout or cancellation after admission consume an attempt. Rejected events,
plain text, draft automatic review and limit refusal do not. A full rerun or
rerun of a model-capable job needs a new admission; publication-only reruns do
not invoke the model or spend another attempt. `limit_exhausted` is logged with
the PR and SHA; inspect the log and do not assume a review ran.

The legacy review counter uses one marked PR comment from the expected numeric author, not
the review report. The command counter uses Actions history; see the budget document. For review, a missing comment creates zero state, including on an old PR or after deletion. API errors, malformed state or duplicate matching comments
are `infra` and fail closed. The owner may correct or reset the comment after
investigating; preserve its exact format and expected author. Deletion loses
history and effectively resets the budget on the next admission. Humans and
agents with sufficient rights can edit or delete the state.

Updates are serialized on a best-effort basis, not atomically: races, cancellation
and edits can lose updates. Neither a strict attempt limit nor a monetary ceiling
is guaranteed, and one invocation may make multiple model requests. For the
exact comment format, lock recovery and risks, see [PR attempt budget](agents/pr-attempt-budget.md).

## Troubleshooting and verification

Inspect Actions for the PR and head SHA first. `timeout` denotes a confirmed time
limit, `infra` an infrastructure/trust/preparation failure, and `agent_failed`
another confirmed agent failure; an unknown cause must be investigated, not
guessed. An outdated cancelled run is not a timeout. A runner forcibly stopped
or a failed publisher may leave no comment: check logs and artifact availability.
After resolving the cause, choose a publication-only retry if available; a retry
that can call the model spends a new attempt and still needs authorization.
Never bypass trust or manually remove an active budget lock to recover a run. A
preparation failure is logged with its fixed OpenCode reason when one is
available (for example the bounded archive download failure); raw network, HTTP,
filesystem and API details are not printed.

The full `mise run check` includes workflow lint and local adapter tests; mock
providers and runtime tests are not evidence of real GitHub permissions or
publication. Record actual commands, outcomes, logs and SHA in the PR; flag any
checks not run.

## Local review adapter

`scripts/opencode-review.ts` exports `reviewSnapshot`. It accepts a path to the
checksum- and version-verified OpenCode runtime, a prepared `ReviewContext`, an
optional DeepSeek API key, and an optional `AbortSignal`. It
returns structured findings or rejects; failures are not reviews. Install the
pinned runtime with `mise run opencode:install -- <directory>`.

The caller must prepare the snapshot from trusted base tooling. Include the
requirements and agreement (or mark them unavailable), base and head SHA,
changes, CI results, and previous review. A release PR need not have an
invented feature specification. The adapter does not fetch or verify these
inputs, publish a review, or implement GitHub integration.

Run the adapter itself from a trusted base revision, not from the PR under
review. It creates a fresh private workspace and treats the snapshot as data;
it does not check out or execute the PR. It strips ambient GitHub credentials,
uses a read-only, default-deny policy and validates the resolved agent before
starting a fresh noninteractive CLI session. The snapshot is split into bounded
JSONL fragments and a review is rejected unless the runtime reports reading
every fragment in full. OpenCode tool permissions are not an
OS sandbox: this isolation does not defend against a compromised runtime or a
hostile local user with access to the process. Avoid secrets in snapshots.

`mise run test:opencode-review-runtime` is intended to exercise the pinned CLI
with a local fixture provider, without real model calls or credentials. Passing
local tests does not demonstrate GitHub publishing.

## GitHub permission experiment

A controlled PR test returned HTTP 403 when publishing a PR comment with `issues: write` and `pull-requests: read`. The same test successfully created and deleted a temporary PR comment with `issues: read` and `pull-requests: write`; the review and publication jobs use the latter permissions. A minimal model probe succeeded, while a full review timed out. See the task plan for run links. The full review is not yet verified; investigate timeout reports before relying on it.

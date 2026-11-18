# PR review: operation and local adapter

## Active handler: gh-aw

Automatic advisory review is handled by
[`agentic-review.md`](../.github/workflows/agentic-review.md) and its generated
lock file. The legacy [`opencode-review.yml`](../.github/workflows/opencode-review.yml)
and `scripts/opencode-review-*` remain in the repository as a disabled rollback
path; they are not the active handler.

The gh-aw workflow runs on `opened`, `synchronize`, `reopened` and
`ready_for_review`. Editing only the description does not start the agent. A
manual `workflow_dispatch` takes a trusted internal PR number and is always
staged: it runs the full agent and writes the Russian draft to the Actions
Summary without creating a comment. A run that reaches the model consumes one
review attempt, including a manual pilot.

Before the model, gh-aw checks the actor role and the `on.bots` allowlist
(`opencode-agent[bot]`, `calendar-release-ignateff-bot[bot]`). The
`review:eligibility` job then checks that the PR is open and internal, is not a
draft, and that its current author is the repository owner, a human with
`admin`/`maintain`/`write`, or one of the allowed bots. Fork PRs, drafts,
unknown bots and trust-check errors skip the budget and the model without
spending an attempt.

The review budget is independent from the command budget: three admitted
attempts per PR, stored in a new PR comment (marker
`<!-- gh-aw-review-attempt-budget:v1 -->`, author `github-actions[bot]`). Old
state is not migrated; a PR without the new comment starts at zero. The pinned
context is collected first, then the `review:budget` job increments the counter
immediately before the agent, so a stale head or context failure does not spend
an attempt. Once admitted, a later cancellation, timeout or agent failure can
consume it. A fourth run is refused without calling the model. See
[PR attempt budget](agents/pr-attempt-budget.md).

A new review cancels the previous automatic review for the same PR at workflow
scope, so an outdated head cannot publish. A manual staged pilot uses a separate
concurrency group and does not cancel an automatic review. The `review:context`
job checks out the trusted default branch (never the PR merge revision) and
builds a bounded snapshot at the pinned base and head through the GitHub API.
The agent runs with `checkout:
false`, Bash, editing and GitHub tools disabled, and reads the snapshot as
data. The snapshot JSON is a compact index: full changed and related sources are
materialized under `review-context/data/`, and the JSON records their paths. The
pinned tree index is not exposed to the agent; it can read only the changed
files and the selected unchanged related files, so a needed but absent file
must be reported as a limitation.
There is no runtime guarantee that every snapshot fragment was read in full;
the prompt requires a full read, and missing, truncated or incomplete evidence
must be listed in the report. The snapshot contains `REVIEW.md` from
the base, changed sources and patches, selected unchanged related code, tests
and contract files, linked requirements and agreement evidence, CI for the
reviewed head, prior reviews and the commit list.

Publication is a separate custom safe-output job (`publish_review`). It
re-verifies the live PR head and repository identity before posting, and checks
the head again before the write. One general comment is posted with the
verified SHA, the Actions run link, a Russian advisory summary, findings and
all collector limitations. The report is deduplicated by the exact result
marker `<!-- gh-aw-review-report:<head-sha>:<content-digest> -->` and the
expected `github-actions[bot]` author, so a publication retry or an identical
full rerun does not create a second comment; a different report for the same
head may be published. A partial rerun of the failed `publish_review` job
reuses the saved agent output artifact and does not call the model or spend an
attempt; if the head moved or the PR closed, publication is refused. Run links
and the published result from controlled PRs are recorded on the tracking issue
for the migration.

To roll back, enable the legacy `opencode-review.yml` workflow in Actions and
disable the gh-aw workflow. Do not delete the old workflow or its entry points:
`mise run opencode:budget review` and `mise run opencode:review-publish` remain
usable. The legacy workflow uses the old comment counter and its own prompt,
context collection and publisher.

## Controlled gh-aw verification (18 November 2026)

The initial rollout was exercised on controlled internal PRs. These runs predate
the final compliance changes (trusted default-branch checkout, admission after
context, result-based deduplication); the final workflow is re-verified below.

- **Automatic review and publication** — [PR #137](https://github.com/ignateff/ai-for-developers-project-387/pull/137)
  produced three reports while the snapshot was being corrected:
  [run 44307270757](https://github.com/ignateff/ai-for-developers-project-387/actions/runs/44307270757),
  [run 44310317201](https://github.com/ignateff/ai-for-developers-project-387/actions/runs/44310317201),
  [run 44313111271](https://github.com/ignateff/ai-for-developers-project-387/actions/runs/44313111271).
  The published comments are
  [#issuecomment-6979281537](https://github.com/ignateff/ai-for-developers-project-387/pull/137#issuecomment-6979281537),
  [#issuecomment-6979774753](https://github.com/ignateff/ai-for-developers-project-387/pull/137#issuecomment-6979774753)
  and [#issuecomment-6980112658](https://github.com/ignateff/ai-for-developers-project-387/pull/137#issuecomment-6980112658).
  The first run found real snapshot gaps (hidden artifact files, silent history
  truncation, oldest-first commit history); those were fixed before merge.
- **Manual staged pilot** — [run 44316591386](https://github.com/ignateff/ai-for-developers-project-387/actions/runs/44316591386)
  ran against PR #136, wrote the Russian draft to the run summary and posted no
  comment.
- **Draft skip** — [run 44318185977](https://github.com/ignateff/ai-for-developers-project-387/actions/runs/44318185977)
  recorded `Авторевью пропущено: draft`; the budget stayed at 2/3 and the model
  was not called.
- **Budget refusal** — [run 44315354861](https://github.com/ignateff/ai-for-developers-project-387/actions/runs/44315354861)
  and [run 44319053230](https://github.com/ignateff/ai-for-developers-project-387/actions/runs/44319053230)
  logged `limit_exhausted` and skipped the agent.
- **Head update cancellation** — [run 44318554654](https://github.com/ignateff/ai-for-developers-project-387/actions/runs/44318554654)
  was cancelled when a new head arrived; the follow-up run was refused by the
  exhausted budget.
- **Publication-only rerun** — re-running only the `publish_review` job of
  [run 44322193457](https://github.com/ignateff/ai-for-developers-project-387/actions/runs/44322193457)
  logged `Авторевью: already-published` and left exactly one
  [report comment](https://github.com/ignateff/ai-for-developers-project-387/pull/144#issuecomment-6981267185)
  without a model call or a new attempt.

### Final compliance verification (PR #147)

After merging the trusted-source, post-context admission and result-dedup
changes, the same scenarios were re-run:

- **Automatic review and publication** — [run 44330519703](https://github.com/ignateff/ai-for-developers-project-387/actions/runs/44330519703)
  published [one report](https://github.com/ignateff/ai-for-developers-project-387/pull/147#issuecomment-6982470104)
  with the marker `<!-- gh-aw-review-report:<head-sha>:<content-digest> -->` and
  budget 1/3.
- **Publication-only rerun** — re-running only the `publish_review` job
  ([job 134899129295](https://github.com/ignateff/ai-for-developers-project-387/actions/runs/44330519703/job/134899129295))
  logged `Авторевью: already-published`; the PR still has exactly one report
  comment.
- **Manual staged pilot** — [run 44332416051](https://github.com/ignateff/ai-for-developers-project-387/actions/runs/44332416051)
  wrote the staged draft to the summary, posted no comment and moved the counter
  to 2/3. The pilot used its separate concurrency group.
- **Budget refusal** — after the third admitted staged run
  ([run 44333641464](https://github.com/ignateff/ai-for-developers-project-387/actions/runs/44333641464)),
  [run 44349263150](https://github.com/ignateff/ai-for-developers-project-387/actions/runs/44349263150)
  built the context but logged `limit_exhausted`; the agent was skipped and the
  counter stayed at 3/3.
- **Draft skip** — [run 44349730110](https://github.com/ignateff/ai-for-developers-project-387/actions/runs/44349730110)
  recorded `Авторевью пропущено: draft`; context, budget and agent were skipped
  and the counter stayed at 3/3.

Head-update cancellation was verified in the initial rollout; the automatic
review concurrency group is unchanged by the final compliance changes.

The new gh-aw workflow is active and the legacy `opencode-review.yml` remains
`disabled_manually`.

## Legacy status and authorization

The rest of this document describes the legacy OpenCode adapter, kept for
rollback and local testing.
GitHub Actions is enabled for the review workflow. A controlled review of
[PR #62](https://github.com/ignateff/ai-for-developers-project-387/pull/62)
completed and published a report ([run 42463395746](https://github.com/ignateff/ai-for-developers-project-387/actions/runs/42463395746)).
This demonstrates that run, not every review scenario. Review is advisory. A human
decides after checking CI, evidence, the current head and each finding.

The reviewer receives `REVIEW.md` from the pinned PR base as context; if it cannot be loaded, the report records an explicit limitation. The PR cannot change its own review criteria. It also receives selected unchanged files from the pinned base and head so related code, tests and contracts can be verified, not only the changed lines.

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

The intended review reads a snapshot and pinned related repository files as data,
not instructions granting authority; it does not execute PR code or publish itself. A separate publisher checks the
current head before posting. Reports should retain SHA and Actions/log links;
outdated results must not be presented as reviewing a newer head. Check the
actual run and comment rather than assuming a missing or failed report means no
defects. Incomplete CI or context is not a pass. A review comment never authorizes
automatic correction; a person must explicitly request it.

## Review context collection

The model job collects a bounded snapshot at the pinned PR base and head:

- changed files, with their full source at both pinned revisions and the diff patch;
- repository trees from the Git Trees API for base and head (`contents: read`), indexed up to 5000 blobs with path, blob SHA and size;
- selected unchanged related files: files imported by changed code, unchanged importers found by a bounded read-only reference scan, tests for or beside the changed files, same-directory sources, and the contract/OpenAPI/SDK chain for API changes. A file counts as unchanged only when its base and head blob SHAs are identical, so one copy is valid at both pinned refs;
- `REVIEW.md`, `AGENTS.md`, `README.md` and `docs/agents/project-history.md` from the pinned base;
- the PR description, explicitly linked issues, comments and approval documents from projects 387/386, CI check-runs and commit statuses for the reviewed head SHA, prior reviews, review comments, discussion comments, and the PR commit list so prior findings and later fixes can be related;
- explicit limitations when trees, CI, prior review or commit data are unavailable, truncated, capped or malformed. The commit list is treated as incomplete when its entries are malformed, and a 250-commit response is flagged as possibly truncated at the GitHub API limit.

Related context is capped at 24 unchanged files and about 320 KB in total; the reference scan is capped at 300 source files and the tree index at 5000 entries. Omitted, unavailable or unexpectedly changed related files are reported as limitations. When the index is truncated, related-file selection still uses the full returned tree, but the reviewer cannot list every pinned file. The legacy reviewer can search the pinned index and read the selected files; it cannot fetch arbitrary index entries, so a needed but absent file must be reported as a limitation. The full repository is not copied into the workspace. Unavailable requirements remain an explicit limitation rather than an assumed pass; incomplete CI, pending checks and missing commit or review history are never treated as successful. Collector limitations are recorded top-level in the snapshot, separate from the agreement sources, so they are not presented as evidence about human approval.

Context selection is implemented in `scripts/opencode-review-repository.ts`, which receives pinned tree readers, a bounded file reader and the shared limitation sink from the workflow; it is not wired into the model job directly. The adapter materializes each related file under `repository/<path>` in the isolated reviewer workspace and includes it in the snapshot, so the reviewer can glob, grep and read it with the existing read-only tools. A review is still rejected unless every snapshot fragment was read in full. Related contents are sent to the model provider exactly like changed-file contents; the workflow does not scan them for secrets, so the repository's accepted secret findings and snapshot-secret guidance still apply. All snapshot and repository content is untrusted data; nothing is executed. These bounded selections are evidence for the reviewer, not proof that the change matches the requirements.

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

Local Vitest covers the related-context collection (pinned trees, cross-directory imported and importing unchanged files, tests, the real contract chain, changed-between-refs exclusion, caps, malformed and truncated trees/indexes, commit validation and the explicit unavailable-context limitation), adapter materialization, the related-file limits and publication wording. Those tests use GitHub API and runtime fixtures. A real GitHub review using the expanded context has not been performed; it needs separate authorization and must be checked for the published SHA and reported limitations like any other run.

## Local review adapter

`scripts/opencode-review.ts` exports `reviewSnapshot`. It accepts a path to the
checksum- and version-verified OpenCode runtime, a prepared `ReviewContext`, an
optional model (`provider/model`) and provider API key, and an optional
`AbortSignal`. The provider key is placed in the credential variable that the
selected provider requires. It returns structured findings or rejects; failures
are not reviews. Install the pinned runtime with
`mise run opencode:install -- <directory>`. The shared default and credential
mapping are described in [OpenCode model configuration](opencode-models.md).

The caller must prepare the snapshot from trusted base tooling. Include the
requirements and agreement (or mark them unavailable), base and head SHA,
changes, the pinned repository index and selected unchanged related files (or a
reason why they are unavailable), CI results, prior commits and previous review.
A release PR need not have an invented feature specification. The adapter does
not fetch or verify these inputs, publish a review, or implement GitHub
integration; it only materializes the supplied related files for search and
rejects malformed or unsafe repository paths.

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

A controlled PR test returned HTTP 403 when publishing a PR comment with `issues: write` and `pull-requests: read`. The same test successfully created and deleted a temporary PR comment with `issues: read` and `pull-requests: write`; the review and publication jobs use the latter permissions. A minimal model probe succeeded, while an earlier full review timed out. A later controlled review published successfully as described above; individual runs can still fail or time out.

# PR review: operation and local adapter

## Status and authorization

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

Related context is capped at 24 unchanged files and about 320 KB in total; the reference scan is capped at 300 source files and the tree index at 5000 entries. Omitted, unavailable or unexpectedly changed related files are reported as limitations. When the index is truncated, related-file selection still uses the full returned tree, but the reviewer cannot list every pinned file. The reviewer can search the pinned index and read the selected files; it cannot fetch arbitrary index entries, so a needed but absent file must be reported as a limitation. The full repository is not copied into the workspace. Unavailable requirements remain an explicit limitation rather than an assumed pass; incomplete CI, pending checks and missing commit or review history are never treated as successful. Collector limitations are recorded top-level in the snapshot, separate from the agreement sources, so they are not presented as evidence about human approval.

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

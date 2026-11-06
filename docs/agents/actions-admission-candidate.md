# Actions admission: read-only candidate (#41)

## GitHub job entry point

`node scripts/actions-gate-cli.ts` reads the GitHub event file and environment,
checks command trust with the existing `authorizeComment`, then queries real
GitHub REST GET endpoints using the harness protocol. It prints only a sanitized
decision and optional hypothetical count/evidence; it writes `decision` and, only
for a hypothetical would-admit, `metadata_candidate` to `GITHUB_OUTPUT`. It always
exits nonzero and never emits an authorization. Before calculation it GETs the
executing run using `GITHUB_RUN_ID` and checks its `workflow_id` against the
configured ID. Missing or inconsistent metadata fails closed.
Review trust is not established and fails closed. Ordinary messages and issues
are skipped; trust/API ambiguity fails closed. The live event must come from the
trusted GitHub runner, not an attacker-controlled local file. The API token needs
read access to Actions and PR metadata and collaborator permissions where needed.

`actions-admission.workflow.yml.example` is an inert template, not an enabled
workflow. Its proposed job name is `budget-model / <command|review> / pr-<n>`
and marker is a completed successful `admission` step. An isolated echo-only
marker can succeed after a hypothetical would-admit; a separate unconditional
step fails the job. The template contains no model invocation. The workflow ID and boundary
are supplied via repository variables `ADMISSION_WORKFLOW_ID` and
`ADMISSION_BOUNDARY_RUN_ID`; they are assertions, not proof of history. Do not
add a model step or treat the hypothetical result as authorization.

After separate approval, operators can copy the template into a dedicated
test repository's `.github/workflows/`, configure the two variables to a numeric
workflow ID and an explicitly recorded run ID, and trigger test PR comments,
review comments and PR events without a model key. Record sanitized run/attempt
URLs and decisions, test pagination and unavailable history, cancellation, full
and job-only reruns, and verify token rights including any exchanged App token.
Testing successful-marker behavior requires a separately reviewed, explicitly
authorized metadata-only experiment. Do not publish tokens or event payloads.
Remove or disable the experimental workflow after the approved observations.
Even if race and cancellation undercount risks are accepted, incomplete or
deleted history, unauthenticated marker names and unverified trust remain hard
blockers. A successful observation alone does not enable this gate.

This is an observation harness, not an admission gate. It has no workflow trigger,
does not invoke a model, and returns `skip` for non-candidates or untrusted
comments and `infra` for candidates and uncertainty; it never authorizes. The previous
in-memory `/admit` fixture was removed; it was not a GitHub API or evidence of
atomic allocation. No live experiment is authorized by this
document; obtain separate approval before using GitHub or checking token rights.

`mise run test:actions-experiment` exercises the external HTTP seam with mocked
responses shaped like GitHub's list workflow runs and list jobs for a run attempt
REST endpoints. These tests demonstrate local handling only, not GitHub behavior.
After separate authorization, an operator can supply a private local JSON file to
`mise run actions:candidate -- /path/to/input.json`, with a read-only Actions token
in `GITHUB_TOKEN`. Never commit payloads containing private comments or tokens.
The script makes GET requests only to `api.github.com`, rejects redirects, and
prints a small result without the token or response bodies. No request is made for
an unrecognized event. Run it only in a trusted environment: the input controls
which repository and Actions history are queried.

Example shape (replace every value with deliberately collected metadata):

```json
{
  "repository": "owner/repo",
  "workflowId": 123,
  "boundaryRunId": 1000,
  "kind": "full",
  "trusted": true,
  "event": "issue_comment",
  "payload": {
    "action": "created",
    "issue": { "number": 7, "pull_request": {} },
    "comment": { "body": "/oc review" }
  },
  "bindings": [{ "runId": 1000, "pr": 7, "budget": "command" }]
}
```

The `kind` and `trusted` values, current event payload, and **every** historical run binding are operator
assertions, not authenticated or recovered from GitHub. The listing endpoint does
not provide the original webhook payload, and empty `pull_requests`, default
branch SHA, and title are not substitutes. `boundaryRunId` is also supplied by
the operator. The existing reader assumes run IDs order history and that seeing
the boundary and consistent paginated counts implies completeness; neither
assumption proves retention or detects deleted history. It requires a binding
for each included completed run. Pending runs are not counted; this does not
resolve concurrency or whether an in-progress run already consumed an attempt.

The older budget inspector expects a successful `admission` step in a job named
`model`; the harness and template instead use `budget-model / <budget> / pr-<n>`.
The reader counts distinct matching job IDs across run attempts, but neither
marker durability on cancellation, visibility timing, nor partial/full re-run
job identity is established. Candidate `used` and `hypothetical` fields are
calculations under these assumptions, **not** a grant, denial, or proof; results
from fixtures have no evidentiary value about GitHub. Job names and step names
can collide, and the reader does not authenticate workflow versions. Concurrent
allocation is not implemented. No caller may run a model based on this output.

Before a real gate is possible, separately approved metadata-only tests must
capture and bind both comment events and PR review events, establish an immutable
history boundary and retention/completeness policy, verify marker visibility and
identity through cancellation and full/partial reruns, and demonstrate serialized
allocation without counting future pending runs. Check all agent-accessible token
permissions, including exchanged App tokens, against history deletion and changes.
GitHub administrators can alter or delete history; this approach cannot protect
against them. Missing evidence remains a blocker for #41, not permission to use
an external database or to enable an existing workflow.

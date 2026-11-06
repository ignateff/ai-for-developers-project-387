# Actions admission: read-only candidate (#41)

This is an observation harness, not an admission gate. It has no workflow trigger,
does not invoke a model, and always returns `decision: "infra"`. The previous
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
for each included run, including pending runs; it cannot decide safely whether
those runs should consume budget.

The proposed marker is a successful `admission` step in a job named `model`.
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

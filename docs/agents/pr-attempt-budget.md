# PR attempt budget adapter

The adapter in `scripts/opencode-budget-workflow.ts` is wired into the command and review model jobs. The review job is explicitly disabled in the checked-in YAML and the GitHub workflow is disabled manually; neither settings changes nor real model calls are authorized by this code. The review runner only saves a local result, does not publish it, and does not collect the full context required by #39: it is not ready to enable. Local tests with mocked GitHub and runtime do not prove GitHub token permissions or cross-runner behavior.

The adapter keeps two independent limits of three admitted attempts in one PR issue comment, distinct from review reports. Its trusted caller supplies the expected numeric comment author ID. A matching marker without that author is ignored. After trust checks it creates the state if missing and increments the relevant count before runtime preparation; an error or cancellation after the update can therefore consume an attempt. Re-running a model-capable adapter invocation requires a fresh admission; publication-only mode does not run the model. Ordinary issues do not receive a PR budget.

The comment body is exactly the marker on one line and the JSON object on the next line, for example:

```text
<!-- opencode-pr-attempt-budget:v1 -->
{"command":0,"review":0}
```

An authorized maintainer can edit the two non-negative integer values to correct or reset the budget. Keep the exact format and author: invalid content or multiple matching comments cause `infra`, requiring a human to resolve the ambiguity. Deleting the comment loses history; the next admission creates a zero state and does not recover old attempts. Both a human and an agent with sufficient rights may edit or delete it.

Command and review workflows have separate execution concurrency groups. Each model job additionally uses the same `opencode-budget-<PR>` group with queueing and no cancellation. The conservative GitHub Actions lock covers the entire model job, not just the short update; a long review can delay a command and vice versa. Admission is a step inside that job, so re-running the model job rechecks and spends again rather than trusting a previous budget job. GitHub comments are not transactional: concurrency outside these jobs, cancellation, and edits or deletion can lose updates. This is best effort, not tamper protection, a strict attempt limit, or a monetary ceiling. One model invocation may produce multiple provider requests. Real model calls and GitHub settings changes require separate authorization.

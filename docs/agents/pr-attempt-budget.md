# PR attempt budget adapter

The local adapter in `scripts/opencode-budget-workflow.ts` is not wired into a GitHub workflow. It does not change GitHub settings or authorize model calls. Until an independently authorized integration uses it, the existing command workflow is **not budgeted**. Local tests with mocked GitHub and runtime do not prove GitHub token permissions or cross-runner behavior.

The adapter keeps two independent limits of three admitted attempts in one PR issue comment, distinct from review reports. Its trusted caller supplies the expected numeric comment author ID. A matching marker without that author is ignored. After trust checks it creates the state if missing and increments the relevant count before runtime preparation; an error or cancellation after the update can therefore consume an attempt. Re-running a model-capable adapter invocation requires a fresh admission; publication-only mode does not run the model. Ordinary issues do not receive a PR budget.

The comment body is exactly the marker on one line and the JSON object on the next line, for example:

```text
<!-- opencode-pr-attempt-budget:v1 -->
{"command":0,"review":0}
```

An authorized maintainer can edit the two non-negative integer values to correct or reset the budget. Keep the exact format and author: invalid content or multiple matching comments cause `infra`, requiring a human to resolve the ambiguity. Deleting the comment loses history; the next admission creates a zero state and does not recover old attempts. Both a human and an agent with sufficient rights may edit or delete it.

The local queue serializes updates only within one process. A future workflow integration must also supply a shared per-PR lock via `withLock`, separate from command and review execution queues. Even then GitHub comments are not transactional: concurrency, cancellation, and edits or deletion can lose updates. This is best effort, not tamper protection, a strict attempt limit, or a monetary ceiling. One model invocation may produce multiple provider requests. Real model calls and GitHub settings changes require separate authorization.

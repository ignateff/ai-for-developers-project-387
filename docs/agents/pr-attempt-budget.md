# PR attempt budget adapter

The adapter in `scripts/opencode-budget-workflow.ts` is wired into the command and review model jobs. The review job is explicitly disabled in the checked-in YAML and the GitHub workflow is disabled manually; neither settings changes nor real model calls are authorized by this code. The review runner does not collect the full context required by #39: it is not ready to enable. Local tests with mocked GitHub and runtime do not prove GitHub token permissions or cross-runner behavior.

The adapter keeps two independent limits of three admitted attempts in one PR issue comment, distinct from review reports. Its trusted caller supplies the expected numeric comment author ID. A matching marker without that author is ignored. After trust checks it creates the state if missing and increments the relevant count before runtime preparation; an error or cancellation after the update can therefore consume an attempt. Re-running a model-capable adapter invocation requires a fresh admission; publication-only mode does not run the model. Ordinary issues do not receive a PR budget.

The comment body is exactly the marker on one line and the JSON object on the next line, for example:

```text
<!-- opencode-pr-attempt-budget:v1 -->
{"command":0,"review":0}
```

An authorized maintainer can edit the two non-negative integer values to correct or reset the budget. Keep the exact format and author: invalid content or multiple matching comments cause `infra`, requiring a human to resolve the ambiguity. Deleting the comment loses history; the next admission creates a zero state and does not recover old attempts. Both a human and an agent with sufficient rights may edit or delete it.

Command and review execution have separate Actions concurrency groups. The budget update uses a separate short-lived queue: each contender creates a temporary issue comment with marker `<!-- opencode-pr-budget-lock:v1 -->`, verifies the expected numeric bot author and waits for older claims to disappear, then removes its own claim before runtime preparation. These are coordination comments, not counter or review-report comments. Creating them can generate GitHub notifications and secondary rate limiting. After forced cancellation a claim can remain: a maintainer must confirm its run has stopped before manually deleting it. Waiting contenders time out and fail closed rather than silently stealing it.

The queue is **best effort**: listing pages and creating/deleting comments are not an atomic transaction; incomplete visibility, concurrent deletion, cancellation, human edits, or a second implementation that ignores the queue can still lose updates. This is not tamper protection, a strict attempt limit, or a monetary ceiling. One model invocation may produce multiple provider requests. Admission stays inside each model-capable job: re-running that job rechecks and spends again. The distinct publication job downloads the original result artifact; re-running only publication neither checks the budget nor invokes the model. It checks current head before posting and avoids reposting an already published artifact; concurrent head changes or publications are still not atomic.

GitHub documents concurrency at [workflow/job scope](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency), and notes that [re-running a specific job retains outputs of jobs not rerun](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs). A separate successful budget job alone would therefore be unsafe for a model-job rerun. The [issue comments API](https://docs.github.com/en/rest/issues/comments) provides create/list/update/delete, not an atomic compare-and-swap. Real model calls and GitHub settings changes require separate authorization.

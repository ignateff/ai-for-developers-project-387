/** Local simulation only: bindings, retention, marker semantics and serialization are unproven. */
type Budget = "command" | "review";
type Binding = { runId: number; pr: number; budget: Budget };
const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** Classifies an event candidate, not its authenticity or the author's trust. */
export function classifyEvent(
  name: string,
  payload: unknown,
): { pr: number; budget: Budget } | undefined {
  const obj = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const event = obj(payload);
  const pr = obj(event.pull_request);
  if (name === "pull_request") {
    if (
      ["opened", "synchronize", "reopened", "ready_for_review"].includes(String(event.action)) &&
      pr.draft === false &&
      positive(pr.number)
    )
      return { pr: pr.number, budget: "review" };
    return;
  }
  if (
    event.action !== "created" ||
    !["issue_comment", "pull_request_review_comment"].includes(name)
  )
    return;
  const comment = obj(event.comment);
  if (typeof comment.body !== "string" || !/(?:^|\s)\/(?:oc|opencode)(?=\s|$)/.test(comment.body))
    return;
  const issue = obj(event.issue);
  if (
    name === "issue_comment" &&
    (!issue.pull_request ||
      typeof issue.pull_request !== "object" ||
      Array.isArray(issue.pull_request))
  )
    return;
  const number = name === "issue_comment" ? issue.number : pr.number;
  if (positive(number)) return { pr: number, budget: "command" };
}

export async function evaluateBudget(options: {
  repository: string;
  token: string;
  workflowId: number;
  boundaryRunId: number;
  bindings: Binding[];
  request: { pr: number; budget: Budget };
  fetch?: typeof fetch;
}): Promise<{
  decision: "infra";
  reason: string;
  hypothetical?: "would-admit" | "limit-exhausted";
  used?: number;
  evidence?: string[];
}> {
  const { repository, token, workflowId, boundaryRunId, bindings, request } = options;
  const fail = (reason: string) => ({ decision: "infra" as const, reason });
  if (
    !/^[a-z\d-]+\/[a-z\d_.-]+$/i.test(repository) ||
    !token ||
    /[\r\n]/.test(token) ||
    !positive(workflowId) ||
    !positive(boundaryRunId) ||
    !positive(request.pr) ||
    !["command", "review"].includes(request.budget) ||
    !Array.isArray(bindings)
  )
    return fail("invalid-input");
  try {
    const byRun = new Map<number, Binding>();
    for (const binding of bindings) {
      if (
        !positive(binding.runId) ||
        !positive(binding.pr) ||
        !["command", "review"].includes(binding.budget) ||
        byRun.has(binding.runId)
      )
        throw new Error();
      byRun.set(binding.runId, binding);
    }
    const getPages = async (path: string, key: "workflow_runs" | "jobs") => {
      const rows: Record<string, unknown>[] = [];
      const ids = new Set<number>();
      let total: number | undefined;
      for (let page = 1; page <= 100; page++) {
        const response = await (options.fetch ?? fetch)(
          `https://api.github.com/repos/${repository}/${path}?per_page=100&page=${page}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
            },
            redirect: "error",
            signal: AbortSignal.timeout(10000),
          },
        );
        if (!response.ok) throw new Error();
        const data = (await response.json()) as Record<string, unknown>;
        if (
          !data ||
          typeof data.total_count !== "number" ||
          !Number.isSafeInteger(data.total_count) ||
          data.total_count < 0 ||
          data.total_count > 10000 ||
          (total !== undefined && total !== data.total_count) ||
          !Array.isArray(data[key])
        )
          throw new Error();
        total = data.total_count;
        const pageRows = data[key];
        if (pageRows.length !== Math.min(100, total - rows.length)) throw new Error();
        for (const row of pageRows) {
          if (!row || typeof row !== "object" || !positive(row.id) || ids.has(row.id))
            throw new Error();
          ids.add(row.id);
          rows.push(row);
        }
        if (rows.length === total) return rows;
      }
      throw new Error();
    };
    const runs = await getPages(`actions/workflows/${workflowId}/runs`, "workflow_runs");
    if (!runs.some((run) => run.id === boundaryRunId)) throw new Error();
    const evidence: string[] = [];
    let used = 0;
    for (const run of runs) {
      if (!positive(run.id) || run.id < boundaryRunId) continue;
      if (!positive(run.run_attempt) || run.run_attempt > 100) throw new Error();
      const binding = byRun.get(run.id);
      if (!binding) throw new Error();
      const jobsSeen = new Set<number>();
      for (let attempt = 1; attempt <= run.run_attempt; attempt++) {
        const jobs = await getPages(`actions/runs/${run.id}/attempts/${attempt}/jobs`, "jobs");
        for (const job of jobs) {
          if (!positive(job.id) || typeof job.name !== "string" || !Array.isArray(job.steps))
            throw new Error();
          if (jobsSeen.has(job.id)) continue;
          jobsSeen.add(job.id);
          if (job.name !== "model") continue;
          const markers = job.steps.filter(
            (step: unknown) =>
              step && typeof step === "object" && "name" in step && step.name === "admission",
          );
          if (markers.length !== 1) throw new Error();
          const marker = markers[0] as Record<string, unknown>;
          if (
            marker.status !== "completed" ||
            !["success", "failure", "skipped", "cancelled"].includes(String(marker.conclusion))
          )
            throw new Error();
          if (
            marker.conclusion === "success" &&
            binding.pr === request.pr &&
            binding.budget === request.budget
          ) {
            used++;
            evidence.push(
              `https://github.com/${repository}/actions/runs/${run.id}/attempts/${attempt}`,
            );
          }
        }
      }
    }
    return {
      decision: "infra",
      reason: "admission-properties-unverified",
      hypothetical: used >= 3 ? "limit-exhausted" : "would-admit",
      used,
      evidence,
    };
  } catch {
    return fail("github-history-unavailable-or-ambiguous");
  }
}

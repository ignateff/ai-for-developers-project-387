import { classifyEvent } from "./actions-budget.ts";

// Local metadata experiment only. Never use this decision to authorize a model.
export async function runHarness(options: {
  repository: string;
  token: string;
  workflowId: number;
  boundaryRunId: number;
  event: string;
  payload: unknown;
  trusted: boolean;
  fetch?: typeof fetch;
}) {
  const binding = classifyEvent(options.event, options.payload);
  if (!binding || !options.trusted) return { decision: "skip" as const };
  try {
    const { repository, token, workflowId, boundaryRunId } = options;
    if (
      !/^[a-z\d-]+\/[a-z\d_.-]+$/i.test(repository) ||
      !token ||
      /[\r\n]/.test(token) ||
      !Number.isSafeInteger(workflowId) ||
      workflowId < 1 ||
      !Number.isSafeInteger(boundaryRunId) ||
      boundaryRunId < 1
    )
      throw new Error();
    const pages = async (path: string, key: string) => {
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
          !Number.isSafeInteger(data.total_count) ||
          (data.total_count as number) < 0 ||
          (data.total_count as number) > 10000 ||
          (total !== undefined && total !== data.total_count) ||
          !Array.isArray(data[key])
        )
          throw new Error();
        total = data.total_count as number;
        const part = data[key] as Record<string, unknown>[];
        if (part.length !== Math.min(100, total - rows.length)) throw new Error();
        for (const row of part) {
          if (
            !row ||
            !Number.isSafeInteger(row.id) ||
            (row.id as number) < 1 ||
            ids.has(row.id as number)
          )
            throw new Error();
          ids.add(row.id as number);
          rows.push(row);
        }
        if (rows.length === total) return rows;
      }
      throw new Error();
    };
    const runs = await pages(`actions/workflows/${workflowId}/runs`, "workflow_runs");
    if (!runs.some((run) => run.id === boundaryRunId)) throw new Error();
    let used = 0;
    const evidence: string[] = [];
    for (const run of runs) {
      const id = run.id as number;
      if (id <= boundaryRunId) continue;
      if (
        !Number.isSafeInteger(run.run_attempt) ||
        (run.run_attempt as number) < 1 ||
        (run.run_attempt as number) > 100
      )
        throw new Error();
      const seen = new Map<number, string>();
      for (let attempt = 1; attempt <= (run.run_attempt as number); attempt++) {
        const jobs = await pages(`actions/runs/${id}/attempts/${attempt}/jobs`, "jobs");
        for (const job of jobs) {
          if (typeof job.name !== "string" || !Array.isArray(job.steps)) throw new Error();
          const signature = JSON.stringify(job);
          const prior = seen.get(job.id as number);
          if (prior !== undefined) {
            if (prior !== signature) throw new Error();
            continue;
          }
          seen.set(job.id as number, signature);
          if (!job.name.startsWith("budget-model / ")) continue;
          const match = /^budget-model \/ (command|review) \/ pr-([1-9]\d*)$/.exec(job.name);
          if (!match || !Number.isSafeInteger(Number(match[2]))) throw new Error();
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
            match[1] === binding.budget &&
            Number(match[2]) === binding.pr
          ) {
            used++;
            evidence.push(
              `https://github.com/${repository}/actions/runs/${id}/attempts/${attempt}`,
            );
          }
        }
      }
    }
    return {
      decision: used >= 3 ? ("limit_exhausted" as const) : ("admit" as const),
      ...binding,
      used,
      evidence,
    };
  } catch {
    return { decision: "infra" as const, reason: "github-history-unavailable-or-ambiguous" };
  }
}

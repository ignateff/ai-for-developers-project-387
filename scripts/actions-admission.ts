/** Metadata-only experiment. Never use this result to authorize a model invocation. */
export async function inspectAdmissionAttempt(options: {
  repository: string;
  runId: number;
  attempt: number;
  token: string;
  fetch?: typeof fetch;
}): Promise<{
  decision: "infra";
  reason: string;
  marker?: "present" | "absent";
  evidence?: string;
}> {
  const { repository, runId, attempt, token } = options;
  if (
    !/^[a-z\d-]+\/[a-z\d_.-]+$/i.test(repository) ||
    !Number.isSafeInteger(runId) ||
    runId < 1 ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1 ||
    !token ||
    /[\r\n]/.test(token)
  ) {
    return { decision: "infra", reason: "invalid-input" };
  }
  try {
    const ids = new Set<number>();
    let total: number | undefined;
    let present = false;
    for (let page = 1; page <= 100; page++) {
      const response = await (options.fetch ?? fetch)(
        `https://api.github.com/repos/${repository}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100&page=${page}`,
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
      const data = (await response.json()) as { total_count?: unknown; jobs?: unknown };
      if (
        !data ||
        typeof data.total_count !== "number" ||
        !Number.isSafeInteger(data.total_count) ||
        data.total_count < 0 ||
        data.total_count > 10000 ||
        !Array.isArray(data.jobs) ||
        (total !== undefined && total !== data.total_count)
      )
        throw new Error();
      total = data.total_count;
      if (data.jobs.length !== Math.min(100, total - ids.size)) throw new Error();
      for (const job of data.jobs) {
        if (
          !job ||
          !Number.isSafeInteger(job.id) ||
          job.id < 1 ||
          ids.has(job.id) ||
          typeof job.name !== "string" ||
          !Array.isArray(job.steps)
        )
          throw new Error();
        ids.add(job.id);
        for (const step of job.steps) {
          if (
            !step ||
            typeof step.name !== "string" ||
            typeof step.status !== "string" ||
            !(step.conclusion === null || typeof step.conclusion === "string")
          )
            throw new Error();
          if (
            job.name === "model" &&
            step.name === "admission" &&
            step.status === "completed" &&
            step.conclusion === "success"
          )
            present = true;
        }
      }
      if (ids.size === total) break;
    }
    if (total === undefined || ids.size !== total) throw new Error();
    return {
      decision: "infra",
      reason: "admission-properties-unverified",
      marker: present ? "present" : "absent",
      evidence: `https://github.com/${repository}/actions/runs/${runId}/attempts/${attempt}`,
    };
  } catch {
    return { decision: "infra", reason: "github-history-unavailable" };
  }
}

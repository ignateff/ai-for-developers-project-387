import { appendFile, readFile } from "node:fs/promises";
import { authorizeComment } from "./opencode-trust.ts";

// Runs created before this cutover are intentionally excluded, including old reruns.
export const CUTOVER_RUN_ID = 42404073264;
const marker = "Record command admission v2";

type Run = { id: number; run_attempt: number; event: string; status: string };
export async function countAdmissions(options: {
  repository: string;
  token: string;
  pr: number;
  runId: number;
  attempt: number;
  fetch?: typeof fetch;
}): Promise<number> {
  const { repository, token, pr, runId, attempt } = options;
  if (
    !/^[\w-]+\/[\w.-]+$/.test(repository) ||
    !token ||
    /[\r\n]/.test(token) ||
    ![pr, runId, attempt].every((x) => Number.isSafeInteger(x) && x > 0) ||
    runId <= CUTOVER_RUN_ID
  )
    throw new Error("invalid budget identity");
  const get = async (path: string) => {
    const r = await (options.fetch ?? fetch)(`https://api.github.com/repos/${repository}/${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error("actions history unavailable");
    return r.json();
  };
  let count = 0;
  let foundCurrent = false;
  for (let page = 1; page <= 100; page++) {
    const data = await get(`actions/workflows/opencode.yml/runs?per_page=100&page=${page}`);
    if (!Array.isArray(data.workflow_runs)) throw new Error("invalid actions history");
    for (const run of data.workflow_runs as Run[]) {
      if (
        !Number.isSafeInteger(run.id) ||
        !Number.isSafeInteger(run.run_attempt) ||
        run.run_attempt < 1
      )
        throw new Error("invalid run");
      if (run.id === runId) {
        if (run.run_attempt < attempt) throw new Error("current attempt not visible");
        foundCurrent = true;
      }
      if (
        run.id <= CUTOVER_RUN_ID ||
        !["issue_comment", "pull_request_review_comment"].includes(run.event)
      )
        continue;
      for (let n = 1; n <= run.run_attempt; n++) {
        if (run.id === runId && n >= attempt) continue;
        const jobs = await get(`actions/runs/${run.id}/attempts/${n}/jobs?per_page=100`);
        if (
          !Array.isArray(jobs.jobs) ||
          !Number.isSafeInteger(jobs.total_count) ||
          jobs.total_count !== jobs.jobs.length ||
          jobs.total_count > 100
        )
          throw new Error("incomplete jobs history");
        const job = jobs.jobs.find(
          (j: { name?: string }) => j.name === `opencode-command-v2-pr-${pr}`,
        );
        if (!job) {
          if (run.status !== "completed") throw new Error("unidentified active run");
          continue;
        }
        if (!Array.isArray(job.steps) || job.steps.length === 0 || job.status !== "completed")
          throw new Error("incomplete attempt history");
        const step = job.steps.find((s: { name?: string }) => s.name === marker);
        if (
          !step ||
          step.status !== "completed" ||
          !["success", "skipped", "cancelled", "failure"].includes(step.conclusion)
        )
          throw new Error("incomplete admission history");
        if (step.conclusion === "success") count++;
      }
    }
    if (data.workflow_runs.length < 100) {
      if (!foundCurrent) throw new Error("current run missing");
      return count;
    }
  }
  throw new Error("actions history limit exceeded");
}

export async function admission(env: NodeJS.ProcessEnv, fetcher: typeof fetch = fetch) {
  const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH ?? "", "utf8"));
  const repository = env.GITHUB_REPOSITORY ?? "";
  const token = env.GH_TOKEN ?? "";
  const decision = await authorizeComment({
    eventName: env.GITHUB_EVENT_NAME ?? "",
    event,
    repository,
    owner: env.GITHUB_REPOSITORY_OWNER ?? "",
    token,
    fetch: fetcher,
  });
  if (!decision.allowed)
    return { status: decision.reason === "github-error" ? "infra" : "skipped" };
  if (event.comment?.user?.type !== "User") return { status: "skipped" };
  const isPr =
    env.GITHUB_EVENT_NAME === "pull_request_review_comment" || Boolean(event.issue?.pull_request);
  if (!isPr) return { status: "allowed" };
  const pr = decision.number!;
  const response = await fetcher(`https://api.github.com/repos/${repository}/pulls/${pr}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error("PR unavailable");
  const details = await response.json();
  if (details.state !== "open" || !/^[a-f\d]{40}$/i.test(details.head?.sha ?? ""))
    throw new Error("invalid PR");
  try {
    const count = await countAdmissions({
      repository,
      token,
      pr,
      runId: Number(env.GITHUB_RUN_ID),
      attempt: Number(env.GITHUB_RUN_ATTEMPT),
      fetch: fetcher,
    });
    return { status: count >= 3 ? "limit_exhausted" : "allowed", pr, sha: details.head.sha };
  } catch {
    return { status: "infra", pr, sha: details.head.sha };
  }
}

if (import.meta.main) {
  try {
    const result = await admission(process.env);
    await appendFile(
      process.env.GITHUB_OUTPUT ?? "",
      `status=${result.status}\npr=${"pr" in result ? result.pr : ""}\nsha=${"sha" in result ? result.sha : ""}\n`,
    );
    console.log(`OpenCode admission: ${result.status}`);
    if (result.status === "infra") process.exitCode = 1;
  } catch {
    console.error("OpenCode admission: infra");
    process.exitCode = 1;
  }
}

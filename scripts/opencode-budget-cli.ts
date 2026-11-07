import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createProductionWorkflow } from "./opencode-production-workflow.ts";
import { prepareCommand, runCommand } from "./opencode-command.ts";
import { reviewWorkflow } from "./opencode-review-workflow.ts";
import { reviewSnapshot } from "./opencode-review.ts";

// github-actions[bot] on github.com; checked by numeric identity, not display name.
const authorId = 41898282;

export async function runBudgetCli(options: {
  kind: "command" | "review";
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  authorId: number;
  prepare?: () => Promise<void>;
  model?: (identity: { number?: number; sha?: string }) => Promise<void>;
}) {
  const { kind, env } = options;
  const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH ?? "", "utf8"));
  const repository = env.GITHUB_REPOSITORY ?? "";
  const runId = env.GITHUB_RUN_ID ?? "";
  const appIds = (env.OPENCODE_REVIEW_APP_IDS ?? "").split(",").filter(Boolean);
  if (appIds.some((id) => !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))))
    throw new Error();
  // The trusted orchestrator holds the key, but preparation and its subprocesses
  // receive an environment without it. It is handed to the runtime only after admission.
  const key = env.DEEPSEEK_API_KEY;
  delete env.DEEPSEEK_API_KEY;
  const base = { ...env };
  // Three minutes remain for job setup uncertainty, artifact upload and reporting.
  const started = Number(env.OPENCODE_REVIEW_STARTED_AT);
  const deadline =
    kind === "review" && Number.isSafeInteger(started) && started > 0
      ? started + 12 * 60_000
      : kind === "review" && env.GITHUB_ACTIONS === "true"
        ? 0
        : Date.now() + 12 * 60_000;
  const controller = new AbortController();
  const bounded = async (action: () => Promise<void>) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Review preparation deadline exceeded");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        action(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("Review preparation deadline exceeded"));
          }, remaining);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const enoughTime = () => {
    if (Date.now() + 300_000 >= deadline) throw new Error("Insufficient time for review");
  };
  const prepare =
    options.prepare ??
    (() => (kind === "command" ? prepareCommand(base) : reviewWorkflow("prepare", base)));
  const model =
    options.model ??
    (async (identity: { number?: number; sha?: string }) => {
      const runtime = {
        ...base,
        DEEPSEEK_API_KEY: key,
        OPENCODE_PR_NUMBER: identity.number?.toString(),
        OPENCODE_HEAD_SHA: identity.sha,
      };
      if (kind === "command") await runCommand(runtime);
      else
        await reviewWorkflow("run", runtime, {
          fetch: (input, init) =>
            options.fetch(input, {
              ...init,
              signal: init?.signal
                ? AbortSignal.any([init.signal, controller.signal])
                : controller.signal,
            }),
          review: (reviewOptions) => {
            enoughTime();
            return reviewSnapshot({ ...reviewOptions, deadline });
          },
        });
    });
  const adapter = createProductionWorkflow({
    fetch: options.fetch,
    prepare: kind === "review" ? () => bounded(prepare) : prepare,
    model:
      kind === "review"
        ? (identity) =>
            bounded(async () => {
              enoughTime();
              await model(identity);
            })
        : model,
  });
  const result = await adapter({
    kind: kind === "command" ? "command" : "review",
    eventName: env.GITHUB_EVENT_NAME ?? "",
    event,
    repository,
    owner: env.GITHUB_REPOSITORY_OWNER ?? "",
    token: env.GH_TOKEN ?? "",
    authorId: options.authorId,
    actionsUrl: `https://github.com/${repository}/actions/runs/${runId}`,
    allowedAppIds: appIds.map(Number),
  });
  const failure = ["infra", "timeout", "agent_failed"].includes(result.status);
  let reportAvailable = result.status === "completed";
  if (kind === "review" && failure && result.sha && result.number) {
    const run = env.GITHUB_RUN_ID ?? "";
    const attempt = env.GITHUB_RUN_ATTEMPT ?? "";
    const temp = env.RUNNER_TEMP;
    if (!temp || !/^[1-9]\d*$/.test(run) || !/^[1-9]\d*$/.test(attempt)) throw new Error();
    const root = join(temp, `opencode-review-${run}-${attempt}`);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await writeFile(join(root, "review.json"), JSON.stringify({ failure: result.status }), {
      flag: "wx",
      mode: 0o600,
    });
    reportAvailable = true;
  }
  console.log(
    `OpenCode budget: ${result.status}${result.number ? ` PR #${result.number}` : ""}${result.sha ? ` head ${result.sha}` : ""}${result.actionsUrl ? ` ${result.actionsUrl}` : ""}`,
  );
  await appendFile(
    env.GITHUB_OUTPUT ?? "",
    `allowed=${result.status === "completed"}\nreport=${reportAvailable}\nnumber=${result.number ?? ""}\nsha=${result.sha ?? ""}\n`,
  );
  return result;
}

if (import.meta.main) {
  try {
    const kind = process.argv[2];
    if ((kind !== "command" && kind !== "review") || process.argv.length !== 3) throw new Error();
    const result = await runBudgetCli({ kind, env: process.env, fetch, authorId });
    if (["infra", "timeout", "agent_failed", "cancelled"].includes(result.status))
      process.exitCode = 1;
  } catch {
    console.error("OpenCode budget: infra");
    process.exitCode = 1;
  }
}

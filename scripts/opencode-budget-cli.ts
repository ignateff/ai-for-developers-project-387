import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createProductionWorkflow } from "./opencode-production-workflow.ts";
import { prepareCommand, runCommand } from "./opencode-command.ts";
import { reviewWorkflow } from "./opencode-review-workflow.ts";

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
  const adapter = createProductionWorkflow({
    fetch: options.fetch,
    prepare:
      options.prepare ??
      (() => (kind === "command" ? prepareCommand(base) : reviewWorkflow("prepare", base))),
    model:
      options.model ??
      (async (identity) => {
        const runtime = {
          ...base,
          DEEPSEEK_API_KEY: key,
          OPENCODE_PR_NUMBER: identity.number?.toString(),
          OPENCODE_HEAD_SHA: identity.sha,
        };
        if (kind === "command") await runCommand(runtime);
        else await reviewWorkflow("run", runtime);
      }),
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

import { appendFile, readFile } from "node:fs/promises";
import { createBudgetWorkflow } from "./opencode-budget-workflow.ts";
import { createCommentBudgetLock } from "./opencode-budget-lock.ts";

// github-actions[bot] on github.com; checked by numeric identity, not display name.
const authorId = 41898282;

async function main() {
  const kind = process.argv[2];
  if (!["command", "review"].includes(kind) || process.argv.length !== 3) throw new Error();
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH ?? "", "utf8"));
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const runId = process.env.GITHUB_RUN_ID ?? "";
  const appIds = (process.env.OPENCODE_REVIEW_APP_IDS ?? "").split(",").filter(Boolean);
  if (appIds.some((id) => !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))))
    throw new Error();
  const adapter = createBudgetWorkflow({
    fetch,
    withLock: createCommentBudgetLock({
      fetch,
      repository,
      token: process.env.GH_TOKEN ?? "",
      authorId,
    }),
    prepare: async () => {},
    model: async () => {},
  });
  const result = await adapter({
    kind: kind === "command" ? "command" : "review",
    eventName: process.env.GITHUB_EVENT_NAME ?? "",
    event,
    repository,
    owner: process.env.GITHUB_REPOSITORY_OWNER ?? "",
    token: process.env.GH_TOKEN ?? "",
    authorId,
    actionsUrl: `https://github.com/${repository}/actions/runs/${runId}`,
    allowedAppIds: appIds.map(Number),
  });
  console.log(
    `OpenCode budget: ${result.status}${result.number ? ` PR #${result.number}` : ""}${result.sha ? ` head ${result.sha}` : ""}${result.actionsUrl ? ` ${result.actionsUrl}` : ""}`,
  );
  await appendFile(
    process.env.GITHUB_OUTPUT ?? "",
    `allowed=${result.status === "completed"}\nnumber=${result.number ?? ""}\nsha=${result.sha ?? ""}\n`,
  );
  if (result.status === "infra") process.exitCode = 1;
}

try {
  await main();
} catch {
  console.error("OpenCode budget: infra");
  process.exitCode = 1;
}

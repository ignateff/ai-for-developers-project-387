import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { publishReview } from "./opencode-review-publish.ts";

export async function publishWorkflow(options: {
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  authorId: number;
  readReport: (path: string) => Promise<any>;
}) {
  const { env } = options;
  if (!env.RUNNER_TEMP) throw new Error();
  const report = await options.readReport(
    join(env.RUNNER_TEMP, "opencode-review-publication", "review.json"),
  );
  await publishReview({
    fetch: options.fetch,
    repository: env.GITHUB_REPOSITORY ?? "",
    token: env.GH_TOKEN ?? "",
    authorId: options.authorId,
    number: Number(env.OPENCODE_PR_NUMBER),
    sha: env.OPENCODE_HEAD_SHA ?? "",
    artifact: env.OPENCODE_REVIEW_ARTIFACT ?? "",
    report,
  });
}

if (import.meta.main) {
  try {
    await publishWorkflow({
      env: process.env,
      fetch,
      authorId: 41898282,
      readReport: async (path) => JSON.parse(await readFile(path, "utf8")),
    });
    console.log("OpenCode review: report published or already present");
  } catch {
    console.error("OpenCode review: publication failed or head is stale; human attention required");
    process.exitCode = 1;
  }
}

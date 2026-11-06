import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { publishReview } from "./opencode-review-publish.ts";

try {
  if (!process.env.RUNNER_TEMP) throw new Error();
  const report = JSON.parse(
    await readFile(
      join(process.env.RUNNER_TEMP, "opencode-review-publication", "review.json"),
      "utf8",
    ),
  );
  await publishReview({
    fetch,
    repository: process.env.GITHUB_REPOSITORY ?? "",
    token: process.env.GH_TOKEN ?? "",
    authorId: 41898282,
    number: Number(process.env.OPENCODE_PR_NUMBER),
    sha: process.env.OPENCODE_HEAD_SHA ?? "",
    artifact: process.env.OPENCODE_REVIEW_ARTIFACT ?? "",
    report,
  });
  console.log("OpenCode review: report published or already present");
} catch {
  console.error("OpenCode review: publication failed or head is stale; human attention required");
  process.exitCode = 1;
}

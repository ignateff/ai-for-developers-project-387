import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { parse } from "yaml";
import { reviewWorkflow } from "./opencode-review-workflow";

test("review fails closed before model invocation without pinned source snapshots", async () => {
  await expect(
    reviewWorkflow("run", {
      RUNNER_TEMP: "/tmp",
      GITHUB_RUN_ID: "1",
      GITHUB_RUN_ATTEMPT: "1",
      DEEPSEEK_API_KEY: "fixture",
      GH_TOKEN: "fixture",
      GITHUB_REPOSITORY: "owner/repo",
      OPENCODE_PR_NUMBER: "7",
      OPENCODE_HEAD_SHA: "a".repeat(40),
    }),
  ).rejects.toThrow("source snapshots unavailable");
});

test("disabled review model job spends inside the rerun job without holding the budget queue", () => {
  const workflow = parse(readFileSync(".github/workflows/opencode-review.yml", "utf8"));
  const job = workflow.jobs.review;
  expect(job.if).toBe("${{ false }}");
  expect(job.concurrency.group).toBe("opencode-review-${{ github.event.pull_request.number }}");
  expect(job.concurrency["cancel-in-progress"]).toBe(true);
  const model = job.steps.findIndex((s: { id?: string }) => s.id === "workflow");
  expect(model).toBeGreaterThan(-1);
  expect(job.steps[model].run).toBe("mise run opencode:budget review");
  expect(JSON.stringify(job.steps.slice(0, model))).not.toContain("secrets.");
  const publish = workflow.jobs.publish;
  expect(publish.needs).toBe("review");
  expect(publish.if).toBe("needs.review.outputs.artifact != ''");
  expect(JSON.stringify(publish)).not.toContain("DEEPSEEK_API_KEY");
  expect(JSON.stringify(publish)).not.toContain("opencode:budget");
  expect(JSON.stringify(publish)).not.toContain("opencode:review-run");
});

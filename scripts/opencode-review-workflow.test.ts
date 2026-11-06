import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { parse } from "yaml";

test("disabled review model job spends inside the rerun job without holding the budget queue", () => {
  const workflow = parse(readFileSync(".github/workflows/opencode-review.yml", "utf8"));
  const job = workflow.jobs.review;
  expect(job.if).toBe("${{ false }}");
  expect(job.concurrency.group).toBe("opencode-review-${{ github.event.pull_request.number }}");
  expect(job.concurrency["cancel-in-progress"]).toBe(true);
  const budget = job.steps.findIndex((s: { id?: string }) => s.id === "budget");
  const prepare = job.steps.findIndex(
    (s: { run?: string }) => s.run === "mise run opencode:review-prepare",
  );
  const model = job.steps.findIndex(
    (s: { run?: string }) => s.run === "mise run opencode:review-run",
  );
  expect(budget).toBeGreaterThan(-1);
  expect(prepare).toBeGreaterThan(budget);
  expect(model).toBeGreaterThan(prepare);
  expect(job.steps[prepare].if).toBe("steps.budget.outputs.allowed == 'true'");
  expect(job.steps[model].if).toBe("steps.budget.outputs.allowed == 'true'");
  expect(JSON.stringify(job.steps.slice(0, model))).not.toContain("secrets.");
  const publish = workflow.jobs.publish;
  expect(publish.needs).toBe("review");
  expect(publish.if).toBe("needs.review.outputs.artifact != ''");
  expect(JSON.stringify(publish)).not.toContain("DEEPSEEK_API_KEY");
  expect(JSON.stringify(publish)).not.toContain("opencode:budget");
  expect(JSON.stringify(publish)).not.toContain("opencode:review-run");
});

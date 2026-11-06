import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { parse } from "yaml";

test("disabled review model job shares the PR budget queue and spends inside the rerun job", () => {
  const workflow = parse(readFileSync(".github/workflows/opencode-review.yml", "utf8"));
  const job = workflow.jobs.review;
  expect(job.if).toBe("${{ false }}");
  expect(workflow.concurrency.group).toBe(
    "opencode-review-${{ github.event.pull_request.number }}",
  );
  expect(workflow.concurrency["cancel-in-progress"]).toBe(true);
  expect(job.concurrency.group).toBe("opencode-budget-${{ github.event.pull_request.number }}");
  expect(job.concurrency["cancel-in-progress"]).toBe(false);
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
});

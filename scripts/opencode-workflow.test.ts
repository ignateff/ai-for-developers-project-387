import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parse } from "yaml";

function workflow() {
  return parse(readFileSync(".github/workflows/opencode.yml", "utf8"));
}

it("bounds command execution to thirty minutes without cancelling an active fix", () => {
  const job = workflow().jobs.opencode;
  expect(job["timeout-minutes"]).toBe(30);
  expect(workflow().concurrency).toEqual({
    group: "opencode-command-${{ github.event.issue.number || github.event.pull_request.number }}",
    "cancel-in-progress": false,
    queue: "max",
  });
  expect(job.concurrency).toEqual({
    group: "opencode-budget-${{ github.event.issue.number || github.event.pull_request.number }}",
    "cancel-in-progress": false,
    queue: "max",
  });
});

it("bootstraps only the trusted default branch with credentials disabled", () => {
  const checkout = workflow().jobs.opencode.steps[0];
  expect(checkout.uses).toBe("actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1");
  expect(checkout.with).toMatchObject({
    ref: "${{ github.event.repository.default_branch }}",
    "persist-credentials": false,
  });
});

it("gates preparation and provider credentials on the trusted-comment preflight", () => {
  const job = workflow().jobs.opencode;
  const steps: Array<{
    id?: string;
    run?: string;
    if?: string;
    uses?: string;
    env?: Record<string, string>;
  }> = job.steps;
  const trust = steps.findIndex((step) => step.id === "trust");
  const budget = steps.findIndex((step) => step.run === "mise run opencode:budget command");
  const prepare = steps.findIndex((step) => step.run === "mise run opencode:prepare");
  const run = steps.findIndex((step) => step.run === "mise run opencode:run");
  expect(trust).toBeGreaterThan(0);
  expect(budget).toBeGreaterThan(trust);
  expect(prepare).toBeGreaterThan(budget);
  expect(run).toBeGreaterThan(prepare);
  expect(steps[trust].run).toBe("mise run opencode:trust");
  for (const index of [prepare, run]) {
    expect(steps[index].if).toBe("steps.budget.outputs.allowed == 'true'");
  }
  expect(steps[run].env?.DEEPSEEK_API_KEY).toBe("${{ secrets.DEEPSEEK_API_KEY }}");
  for (const step of steps.slice(0, run)) {
    expect(JSON.stringify(step)).not.toContain("secrets.");
  }
  expect(job.permissions).toEqual({
    "id-token": "write",
    contents: "read",
    "pull-requests": "read",
    issues: "write",
  });
  for (const step of steps.filter((step) => step.uses)) {
    expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
  }
});

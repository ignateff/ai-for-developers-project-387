import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parse } from "yaml";

it("disables the original command classifier while enabling the upstream experiment", () => {
  const original = parse(readFileSync(".github/workflows/opencode.yml", "utf8"));
  const experiment = parse(
    readFileSync(".github/workflows/opencode-upstream-experiment.yml", "utf8"),
  );
  expect(original.on.workflow_dispatch).toBeNull();
  expect(original.on.issue_comment).toBeUndefined();
  expect(original.on.pull_request_review_comment).toBeUndefined();
  expect(experiment.on.issue_comment.types).toEqual(["created"]);
  expect(experiment.on.pull_request_review_comment.types).toEqual(["created"]);
  const steps = experiment.jobs.experiment.steps;
  const trust = steps.find((step: { id?: string }) => step.id === "trust");
  const upstream = steps.find((step: { name?: string }) => step.name === "Run upstream OpenCode");
  expect(trust.run).toBe("mise run opencode:trust");
  expect(upstream.if).toBe("steps.trust.outputs.allowed == 'true'");
  expect(upstream.with.model).toBe("deepseek/deepseek-flash");
  expect(upstream.uses).toBe("anomalyco/opencode/github@810c0eba1a7348036f8bdf61e6632d0c36c6876c");
});

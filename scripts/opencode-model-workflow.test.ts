import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { defaultOpenCodeModel } from "./opencode-model.ts";

const read = (path: string) => readFileSync(path, "utf8");
const workflow = (path: string) => parse(read(path));

const modelSteps = {
  commandPrepare: () =>
    workflow(".github/workflows/opencode.yml").jobs.opencode.steps.find(
      (step: { id?: string }) => step.id === "prepare",
    ),
  commandRun: () =>
    workflow(".github/workflows/opencode.yml").jobs.opencode.steps.find(
      (step: { id?: string }) => step.id === "command",
    ),
  review: () =>
    workflow(".github/workflows/opencode-review.yml").jobs.review.steps.find(
      (step: { id?: string }) => step.id === "workflow",
    ),
  triage: () =>
    workflow(".github/workflows/opencode-triage.yml").jobs.triage.steps.find(
      (step: { name?: string }) => step.name === "Предварительный триаж",
    ),
  scheduledAudit: () =>
    workflow(".github/workflows/scheduled-performance-audit.yml").jobs.lighthouse.steps.find(
      (step: { name?: string }) => step.name === "Проанализировать с помощью OpenCode",
    ),
  performanceCheck: () =>
    workflow(".github/workflows/performance-check.yml").jobs.lighthouse.steps.find(
      (step: { name?: string }) => step.name === "Проанализировать с помощью OpenCode",
    ),
};

it("routes every applicable workflow through the repository variable", () => {
  for (const [name, get] of Object.entries(modelSteps)) {
    const step = get();
    expect(step, name).toBeDefined();
    expect(step.env.OPENCODE_MODEL, name).toBe("${{ vars.OPENCODE_MODEL }}");
  }
});

it("keeps the shared default out of workflow files", () => {
  for (const path of [
    ".github/workflows/opencode.yml",
    ".github/workflows/opencode-review.yml",
    ".github/workflows/opencode-triage.yml",
    ".github/workflows/scheduled-performance-audit.yml",
    ".github/workflows/performance-check.yml",
  ]) {
    const source = read(path);
    expect(source, path).not.toContain(defaultOpenCodeModel);
    expect(source, path).not.toContain("deepseek/deepseek-flash");
  }
});

it("passes both provider credentials only to model-capable steps", () => {
  for (const [name, get] of Object.entries(modelSteps)) {
    if (name === "commandPrepare") continue;
    const step = get();
    expect(step.env.OPENCODE_API_KEY, name).toBe("${{ secrets.OPENCODE_API_KEY }}");
    expect(step.env.DEEPSEEK_API_KEY, name).toBe("${{ secrets.DEEPSEEK_API_KEY }}");
  }
  const prepare = modelSteps.commandPrepare();
  expect(prepare.env.OPENCODE_MODEL).toBe("${{ vars.OPENCODE_MODEL }}");
  expect(JSON.stringify(prepare)).not.toContain("secrets.");
  const report = workflow(".github/workflows/opencode.yml").jobs.report;
  expect(JSON.stringify(report)).not.toContain("secrets.");
  const publish = workflow(".github/workflows/opencode-review.yml").jobs.publish;
  expect(JSON.stringify(publish)).not.toContain("OPENCODE_API_KEY");
  expect(JSON.stringify(publish)).not.toContain("DEEPSEEK_API_KEY");
});

it("uses the shared launcher for direct CLI invocations", () => {
  for (const get of [modelSteps.triage, modelSteps.scheduledAudit, modelSteps.performanceCheck]) {
    expect(get().run).toContain('node scripts/opencode-launch.ts "$OPENCODE_');
  }
  expect(modelSteps.commandRun().run).toContain("node scripts/opencode-model.ts check");
  expect(modelSteps.review().run).toBe("mise run opencode:budget review");
});

it("keeps the diagnostic on its separate fixed model without production credentials", () => {
  const source = read(".github/workflows/opencode-diagnostic.yml");
  expect(source).not.toContain("vars.OPENCODE_MODEL");
  expect(source).not.toContain("OPENCODE_MODEL:");
  expect(source).not.toContain("OPENCODE_API_KEY");
  expect(source).not.toContain("DEEPSEEK_API_KEY");
  const job = workflow(".github/workflows/opencode-diagnostic.yml").jobs.diagnostic;
  expect(job.permissions).toEqual({ contents: "read" });
  const diagnostic = read("scripts/opencode-github-diagnostic.ts");
  expect(diagnostic).toContain('const diagnosticModel = "opencode/big-pickle"');
  expect(diagnostic).toContain("env.MODEL = diagnosticModel");
});

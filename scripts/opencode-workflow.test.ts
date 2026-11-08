import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { parse } from "yaml";

function workflow() {
  return parse(readFileSync(".github/workflows/opencode.yml", "utf8"));
}

it.each([
  ["ordinary /ocelot", "false"],
  ["hello\n/oc fix", "true"],
  ["/opencode", "true"],
  ["ordinary", "false"],
])("classifies %s before entering command queue", (body, expected) => {
  const dir = mkdtempSync(join(tmpdir(), "oc-classify-"));
  try {
    const output = join(dir, "output");
    const result = spawnSync("bash", ["-c", workflow().jobs.classify.steps[0].run], {
      env: { ...process.env, COMMENT_BODY: body, GITHUB_OUTPUT: output },
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(readFileSync(output, "utf8")).toBe(`command=${expected}\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("bounds command execution to thirty minutes without cancelling an active fix", () => {
  const job = workflow().jobs.opencode;
  expect(job["timeout-minutes"]).toBe(30);
  expect(job.needs).toBe("classify");
  expect(job.if).toBe("needs.classify.outputs.command == 'true'");
  expect(workflow().jobs.classify.concurrency).toBeUndefined();
  expect(workflow().concurrency).toBeUndefined();
  expect(job.concurrency).toEqual({
    group: "opencode-command-${{ github.event.issue.number || github.event.pull_request.number }}",
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

it("records admission before giving the model access to credentials", () => {
  const job = workflow().jobs.opencode;
  const steps = job.steps;
  const admission = steps.findIndex((step: { id?: string }) => step.id === "admission");
  const marker = steps.findIndex(
    (step: { name?: string }) => step.name === "Record command admission v2",
  );
  const command = steps.findIndex((step: { id?: string }) => step.id === "command");
  expect(admission).toBeGreaterThan(0);
  expect(marker).toBeGreaterThan(admission);
  expect(command).toBeGreaterThan(marker);
  expect(steps[command].env.DEEPSEEK_API_KEY).toBe("${{ secrets.DEEPSEEK_API_KEY }}");
  expect(JSON.stringify(steps.slice(0, command))).not.toContain("secrets.");
  expect(job.permissions).toMatchObject({ actions: "read", issues: "write", contents: "read" });
});

it("isolates PR reporting permission from the model job", () => {
  const jobs = workflow().jobs;
  expect(jobs.opencode.permissions["pull-requests"]).toBe("read");
  expect(jobs.report.needs).toBe("opencode");
  expect(jobs.report.permissions).toMatchObject({ issues: "read", "pull-requests": "write" });
  expect(JSON.stringify(jobs.report)).not.toContain("DEEPSEEK_API_KEY");
});

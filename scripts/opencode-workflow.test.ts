import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

it("bounds command execution to two and a half hours without cancelling an active fix", () => {
  const job = workflow().jobs.opencode;
  expect(job["timeout-minutes"]).toBe(150);
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

it("gives the agent two hours inside a 130-minute step and a 150-minute job", () => {
  const job = workflow().jobs.opencode;
  const command = job.steps.find((step: { id?: string }) => step.id === "command");
  expect(command.env.OPENCODE_RAW_OUTPUT).toBe("1");
  expect(command["timeout-minutes"]).toBe(130);
  expect(command["continue-on-error"]).toBe(true);
  expect(command.run).toContain(
    "timeout --signal=TERM --kill-after=10s 120m mise run opencode:run",
  );
  expect(job["timeout-minutes"]).toBe(150);
  expect(command.run).toContain('if [ "$result" -eq 124 ]');
  expect(command.run).toContain("reason=timeout");
  expect(command.run).toContain('if [ "$result" -eq 137 ]');
  expect(command.run).toContain("reason=unknown");
  expect(command.run).toContain("reason=agent_failed");
  expect(command.run).toContain("reason=infra");
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
  expect(steps[command].env.OPENCODE_API_KEY).toBe("${{ secrets.OPENCODE_API_KEY }}");
  expect(JSON.stringify(steps.slice(0, command))).not.toContain("secrets.");
  expect(job.permissions).toMatchObject({ actions: "read", issues: "write", contents: "read" });
});

it("isolates PR reporting permission from the model job", () => {
  const jobs = workflow().jobs;
  expect(jobs.opencode.permissions["pull-requests"]).toBe("read");
  expect(jobs.report.needs).toBe("opencode");
  expect(jobs.report.permissions).toEqual({ issues: "write", "pull-requests": "write" });
  expect(jobs.report.if).toContain("!cancelled()");
  expect(jobs.report.if).toContain("needs.opencode.outputs.reason != ''");
  const report = JSON.stringify(jobs.report);
  expect(report).not.toContain("DEEPSEEK_API_KEY");
  expect(report).not.toContain("OPENCODE_API_KEY");
  expect(report).not.toContain("secrets.");
});

it("explains each failure reason without confirming task completion", () => {
  const report = workflow().jobs.report.steps[0];
  expect(report.name).toBe("Report command outcome");
  expect(report.env).toEqual({
    GH_TOKEN: "${{ github.token }}",
    TARGET_NUMBER: "${{ github.event.issue.number || github.event.pull_request.number }}",
    PR_SHA: "${{ needs.opencode.outputs.sha }}",
    REASON: "${{ needs.opencode.outputs.reason }}",
    RUN_URL: "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}",
  });
  expect(report.run).toContain("**OpenCode command failed. Task completion is NOT confirmed.**");
  expect(report.run).toContain('timeout) explanation="the agent hit the 2-hour work limit');
  expect(report.run).toContain(
    'limit_exhausted) explanation="the attempt budget for this issue or pull request is exhausted"',
  );
  expect(report.run).toContain(
    'infra) explanation="the workflow could not start the agent (infrastructure or preparation failure)"',
  );
  expect(report.run).toContain(
    'agent_failed) explanation="the agent failed before publishing a verified result"',
  );
  expect(report.run).toContain('*) explanation="unknown cause"');
  expect(report.run).toContain('"$REASON"');
  expect(report.run).toContain("sha=${PR_SHA:-unknown}");
  expect(report.run).toContain('"$sha"');
  expect(report.run).toContain('"$RUN_URL"');
});

it("fails the report step when the failure comment cannot be published", () => {
  const report = workflow().jobs.report.steps[0];
  expect(report["continue-on-error"]).toBeUndefined();
  expect(report.run).toContain(
    'comment_id=$(gh api "repos/$GITHUB_REPOSITORY/issues/$TARGET_NUMBER/comments"',
  );
  expect(report.run).toContain("--jq .id");
  expect(report.run).toContain('if [ -z "$comment_id" ] || [ "$comment_id" = "null" ]');
  expect(report.run.indexOf('if [ -z "$comment_id" ]')).toBeLessThan(
    report.run.indexOf('echo "Published failure comment'),
  );
  expect(report.run).toContain("exit 1");
});

it("summarizes only allowlisted runtime log events after a failed command", () => {
  const steps = workflow().jobs.opencode.steps;
  const command = steps.findIndex((step: { id?: string }) => step.id === "command");
  const summary = steps.findIndex(
    (step: { run?: string }) => step.run === "mise run opencode:log-summary",
  );
  expect(command).toBeGreaterThan(0);
  expect(summary).toBeGreaterThan(command);
  expect(steps[summary].if).toContain("!cancelled()");
  expect(steps[summary].if).toContain("steps.prepare.outcome == 'success'");
  expect(steps[summary]["continue-on-error"]).toBe(true);
  expect(steps[summary].env).toEqual({
    OPENCODE_COMMAND_DIR: "${{ runner.temp }}/oc-${{ github.run_id }}-${{ github.run_attempt }}",
  });
  expect(JSON.stringify(steps[summary])).not.toContain("secrets.");
});

it("bounds preparation and diagnostics so the job keeps room to report", () => {
  const steps = workflow().jobs.opencode.steps;
  const prepare = steps.find((step: { id?: string }) => step.id === "prepare");
  const summary = steps.find(
    (step: { run?: string }) => step.run === "mise run opencode:log-summary",
  );
  expect(prepare["timeout-minutes"]).toBe(6);
  expect(summary["timeout-minutes"]).toBe(5);
  const job = workflow().jobs.opencode;
  const command = steps.find((step: { id?: string }) => step.id === "command");
  expect(command["timeout-minutes"]).toBeGreaterThan(120 + 10 / 60);
  expect(job["timeout-minutes"]).toBeGreaterThan(
    command["timeout-minutes"] + prepare["timeout-minutes"] + summary["timeout-minutes"],
  );
});

it("classifies failures for ordinary issue commands, not only pull requests", () => {
  const classify = workflow().jobs.opencode.steps.find(
    (step: { id?: string }) => step.id === "outcome",
  );
  expect(classify.if).not.toMatch(/steps\.admission\.outputs\.pr != '' \&\& \(steps\.admission/);
  expect(classify.if).toContain("steps.admission.outputs.status == 'allowed'");
  expect(classify.if).toContain("steps.prepare.outcome == 'failure'");
  expect(classify.if).toContain("steps.command.outcome == 'failure'");
  expect(classify.if).toContain("steps.admission.outputs.status == 'limit_exhausted'");
  expect(classify.if).toContain("steps.admission.outputs.status == 'infra'");
});

it("comments on the source issue and fails if the comment is not published", () => {
  const report = workflow().jobs.report.steps[0];
  const dir = mkdtempSync(join(tmpdir(), "oc-report-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const argsFile = join(dir, "args.json");
    const publish = (exitCode: number, output: string) => {
      writeFileSync(
        join(bin, "gh"),
        [
          "#!/bin/sh",
          'printf "%s\\n" "$@" > "$GH_ARGS_FILE"',
          `printf "%s\\n" '${output}'`,
          `exit ${exitCode}`,
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      return spawnSync("/bin/bash", ["-c", report.run], {
        env: {
          PATH: bin,
          GH_TOKEN: "fixture-token",
          GH_ARGS_FILE: argsFile,
          GITHUB_REPOSITORY: "fixture/repo",
          TARGET_NUMBER: "83",
          PR_SHA: "",
          REASON: "agent_failed",
          RUN_URL: "https://example.invalid/run/1",
        },
        encoding: "utf8",
      });
    };
    const success = publish(0, '{"id":42}');
    expect(success.status).toBe(0);
    const args = readFileSync(argsFile, "utf8");
    expect(args).toContain("repos/fixture/repo/issues/83/comments");
    expect(args).toContain("--jq");
    expect(args).toContain("Task completion is NOT confirmed");
    expect(args).toContain("SHA: unknown");
    expect(args).toContain("https://example.invalid/run/1");
    expect(args).not.toContain("fixture-token");
    expect(publish(0, "null").status).not.toBe(0);
    expect(publish(1, "").status).not.toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("listens for command comments and only this workflow does", () => {
  const parsed = workflow();
  expect(parsed.on.issue_comment.types).toEqual(["created"]);
  expect(parsed.on.pull_request_review_comment.types).toEqual(["created"]);
  expect(parsed.on.workflow_dispatch).toBeUndefined();
  const directory = ".github/workflows";
  const otherHandlers = readdirSync(directory)
    .filter((file) => file.endsWith(".yml") && file !== "opencode.yml")
    .filter((file) => {
      const other = parse(readFileSync(join(directory, file), "utf8"));
      return Boolean(other.on?.issue_comment || other.on?.pull_request_review_comment);
    });
  expect(otherHandlers).toEqual([]);
});

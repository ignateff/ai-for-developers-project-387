import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { runHarness } from "./actions-harness.ts";

it("does not count pending runs even if their jobs expose a successful marker", async () => {
  let jobCalls = 0;
  const result = await runHarness({
    repository: "owner/repo",
    token: "fixture",
    workflowId: 10,
    boundaryRunId: 1,
    event: "issue_comment",
    payload: {
      action: "created",
      issue: { number: 7, pull_request: {} },
      comment: { body: "/oc" },
    },
    trusted: true,
    fetch: async (url) => {
      if (String(url).includes("/workflows/"))
        return Response.json({
          total_count: 2,
          workflow_runs: [{ id: 1 }, { id: 2, status: "in_progress", run_attempt: 1 }],
        });
      jobCalls++;
      return Response.json({
        total_count: 1,
        jobs: [
          {
            id: 2,
            name: "budget-model / command / pr-7",
            status: "in_progress",
            steps: [{ name: "admission", status: "completed", conclusion: "success" }],
          },
        ],
      });
    },
  });
  expect(result).toMatchObject({ decision: "admit", used: 0 });
  expect(jobCalls).toBe(0);
});

it.each([
  [[]],
  [[{ id: 9, name: "unknown", status: "completed", steps: [] }]],
  [
    [
      { id: 9, name: "budget-model / command / pr-7", status: "completed", steps: [] },
      { id: 10, name: "budget-model / command / pr-7", status: "completed", steps: [] },
    ],
  ],
])("rejects completed history without an identifiable marker job", async (jobs) => {
  const result = await runHarness({
    repository: "owner/repo",
    token: "fixture",
    workflowId: 10,
    boundaryRunId: 1,
    event: "issue_comment",
    payload: {
      action: "created",
      issue: { number: 7, pull_request: {} },
      comment: { body: "/oc" },
    },
    trusted: true,
    fetch: async (url) =>
      String(url).includes("/workflows/")
        ? Response.json({
            total_count: 2,
            workflow_runs: [{ id: 1 }, { id: 2, run_attempt: 1, status: "completed" }],
          })
        : Response.json({ total_count: jobs.length, jobs }),
  });
  expect(result.decision).toBe("infra");
});

it("runs the metadata harness as a process using only fixture REST responses", () => {
  const fixture = {
    options: {
      repository: "owner/repo",
      workflowId: 10,
      boundaryRunId: 1,
      event: "issue_comment",
      payload: {
        action: "created",
        issue: { number: 7, pull_request: {} },
        comment: { body: "/oc fix" },
      },
      trusted: true,
    },
    responses: {
      "/repos/owner/repo/actions/workflows/10/runs?per_page=100&page=1": {
        total_count: 1,
        workflow_runs: [{ id: 1, run_attempt: 1, status: "completed" }],
      },
    },
  };
  const process = spawnSync("node", ["scripts/actions-harness-cli.ts"], {
    input: JSON.stringify(fixture),
    encoding: "utf8",
  });
  expect(process.status).toBe(0);
  expect(JSON.parse(process.stdout)).toMatchObject({ decision: "admit", pr: 7, used: 0 });
});

it("admits a trusted command with an empty retained history before simulated runtime", async () => {
  const result = await runHarness({
    repository: "owner/repo",
    token: "test-token",
    workflowId: 10,
    boundaryRunId: 1,
    event: "issue_comment",
    payload: {
      action: "created",
      issue: { number: 7, pull_request: {} },
      comment: { body: "/oc fix" },
    },
    trusted: true,
    fetch: async () =>
      Response.json({
        total_count: 1,
        workflow_runs: [{ id: 1, run_attempt: 1, status: "completed" }],
      }),
  });
  expect(result).toMatchObject({ decision: "admit", pr: 7, budget: "command", used: 0 });
});

it("counts admitted jobs across reruns once and enforces independent PR budgets", async () => {
  const marker = (id: number, name: string) => ({
    id,
    name,
    status: "completed",
    steps: [{ name: "admission", status: "completed", conclusion: "success" }],
  });
  const fetcher: typeof fetch = async (url) => {
    const path = String(url);
    if (path.includes("/workflows/"))
      return Response.json({
        total_count: 2,
        workflow_runs: [
          { id: 1, run_attempt: 1, status: "completed" },
          { id: 2, run_attempt: 4, status: "completed" },
        ],
      });
    const attempt = Number(path.match(/attempts\/(\d+)/)?.[1]);
    return Response.json({
      total_count: 1,
      jobs: [marker(attempt === 4 ? 3 : attempt, "budget-model / command / pr-7")],
    });
  };
  const options = {
    repository: "owner/repo",
    token: "test-token",
    workflowId: 10,
    boundaryRunId: 1,
    trusted: true,
    fetch: fetcher,
  };
  const command = {
    event: "pull_request_review_comment",
    payload: { action: "created", pull_request: { number: 7 }, comment: { body: "/oc fix" } },
  };
  expect(await runHarness({ ...options, ...command })).toMatchObject({
    decision: "limit_exhausted",
    used: 3,
  });
  expect(
    await runHarness({
      ...options,
      event: "pull_request",
      payload: { action: "synchronize", pull_request: { number: 7, draft: false } },
    }),
  ).toMatchObject({ decision: "admit", used: 0 });
  expect(await runHarness({ ...options, ...command, trusted: false })).toEqual({
    decision: "skip",
  });
});

it("fails closed when retained history or marker metadata is unavailable", async () => {
  const options = {
    repository: "owner/repo",
    token: "test-token",
    workflowId: 10,
    boundaryRunId: 1,
    event: "issue_comment",
    payload: {
      action: "created",
      issue: { number: 7, pull_request: {} },
      comment: { body: "/oc fix" },
    },
    trusted: true,
  };
  expect(
    await runHarness({ ...options, fetch: async () => new Response("secret", { status: 403 }) }),
  ).toEqual({ decision: "infra", reason: "github-history-unavailable-or-ambiguous" });
  expect(
    await runHarness({
      ...options,
      fetch: async (url) =>
        String(url).includes("/workflows/")
          ? Response.json({
              total_count: 2,
              workflow_runs: [
                { id: 1, run_attempt: 1, status: "completed" },
                { id: 2, run_attempt: 1, status: "completed" },
              ],
            })
          : Response.json({
              total_count: 1,
              jobs: [
                { id: 2, name: "budget-model / command / pr-7", status: "completed", steps: [] },
              ],
            }),
    }),
  ).toEqual({ decision: "infra", reason: "github-history-unavailable-or-ambiguous" });
});

it("does not spend on ordinary issues, text, or draft reviews", async () => {
  const options = {
    repository: "owner/repo",
    token: "fixture",
    workflowId: 10,
    boundaryRunId: 1,
    trusted: true,
    fetch: async () => {
      throw new Error("unexpected API call");
    },
  };
  expect(
    await runHarness({
      ...options,
      event: "issue_comment",
      payload: { action: "created", issue: { number: 7 }, comment: { body: "/oc fix" } },
    }),
  ).toEqual({ decision: "skip" });
  expect(
    await runHarness({
      ...options,
      event: "issue_comment",
      payload: {
        action: "created",
        issue: { number: 7, pull_request: {} },
        comment: { body: "hello" },
      },
    }),
  ).toEqual({ decision: "skip" });
  expect(
    await runHarness({
      ...options,
      event: "pull_request",
      payload: { action: "opened", pull_request: { number: 7, draft: true } },
    }),
  ).toEqual({ decision: "skip" });
});

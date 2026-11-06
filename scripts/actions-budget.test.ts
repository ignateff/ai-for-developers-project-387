import { expect, it } from "vitest";
import { classifyEvent, evaluateBudget } from "./actions-budget.ts";

it("counts separate budgets from paginated Actions history without granting model access", async () => {
  const fetcher: typeof fetch = async (url) => {
    if (String(url).includes("/actions/workflows/10/runs?"))
      return Response.json({
        total_count: 2,
        workflow_runs: [
          { id: 1, run_attempt: 1 },
          { id: 2, run_attempt: 1 },
        ],
      });
    return Response.json({
      total_count: 1,
      jobs: [
        {
          id: 100,
          name: "model",
          steps: [{ name: "admission", status: "completed", conclusion: "success" }],
        },
      ],
    });
  };
  const result = await evaluateBudget({
    repository: "owner/repo",
    token: "secret",
    workflowId: 10,
    boundaryRunId: 1,
    bindings: [
      { runId: 1, pr: 7, budget: "command" },
      { runId: 2, pr: 7, budget: "review" },
    ],
    request: { pr: 7, budget: "command" },
    fetch: fetcher,
  });
  expect(result).toMatchObject({
    decision: "infra",
    reason: "admission-properties-unverified",
    hypothetical: "would-admit",
    used: 1,
  });
});

it("binds both comment channels and reviews from event payloads, never Actions SHA or pull_requests", () => {
  expect(
    classifyEvent("issue_comment", {
      action: "created",
      issue: { number: 7, pull_request: {} },
      comment: { body: "/oc fix" },
    }),
  ).toEqual({ pr: 7, budget: "command" });
  expect(
    classifyEvent("pull_request_review_comment", {
      action: "created",
      pull_request: { number: 7 },
      comment: { body: "/opencode fix" },
    }),
  ).toEqual({ pr: 7, budget: "command" });
  expect(
    classifyEvent("pull_request", {
      action: "synchronize",
      pull_request: { number: 7, draft: false },
    }),
  ).toEqual({ pr: 7, budget: "review" });
  expect(
    classifyEvent("issue_comment", {
      action: "created",
      issue: { number: 7 },
      comment: { body: "/oc fix" },
      pull_requests: [{ number: 7 }],
    }),
  ).toBeUndefined();
  expect(
    classifyEvent("issue_comment", {
      action: "created",
      issue: { number: 7, pull_request: {} },
      comment: { body: "hello" },
    }),
  ).toBeUndefined();
  expect(
    classifyEvent("pull_request", { action: "opened", pull_request: { number: 7, draft: true } }),
  ).toBeUndefined();
});

it("counts new model jobs on rerun but not a reused model job on publication-only rerun", async () => {
  const fetcher: typeof fetch = async (url) => {
    const path = String(url);
    if (path.includes("/workflows/"))
      return Response.json({ total_count: 1, workflow_runs: [{ id: 1, run_attempt: 4 }] });
    const attempt = Number(path.match(/attempts\/(\d+)/)?.[1]);
    return Response.json({
      total_count: 1,
      jobs: [
        {
          id: attempt === 4 ? 3 : attempt,
          name: "model",
          steps: [{ name: "admission", status: "completed", conclusion: "success" }],
        },
      ],
    });
  };
  const options = {
    repository: "owner/repo",
    token: "secret",
    workflowId: 10,
    boundaryRunId: 1,
    bindings: [{ runId: 1, pr: 7, budget: "command" as const }],
    request: { pr: 7, budget: "command" as const },
    fetch: fetcher,
  };
  expect(await evaluateBudget(options)).toMatchObject({
    decision: "infra",
    hypothetical: "limit-exhausted",
    used: 3,
  });
  expect(await evaluateBudget({ ...options, request: { pr: 7, budget: "review" } })).toMatchObject({
    decision: "infra",
    hypothetical: "would-admit",
    used: 0,
  });
  expect(await evaluateBudget({ ...options, request: { pr: 8, budget: "command" } })).toMatchObject(
    { used: 0 },
  );
});

it.each(["missing-binding", "missing-boundary", "api-error", "truncated", "uncertain-marker"])(
  "fails closed for %s",
  async (scenario) => {
    const fetcher: typeof fetch = async (url) => {
      if (scenario === "api-error") return new Response("secret", { status: 403 });
      if (String(url).includes("/workflows/"))
        return Response.json({
          total_count: scenario === "truncated" ? 2 : 1,
          workflow_runs: [{ id: 1, run_attempt: 1 }],
        });
      return Response.json({
        total_count: 1,
        jobs: [
          {
            id: 1,
            name: "model",
            steps:
              scenario === "uncertain-marker"
                ? []
                : [{ name: "admission", status: "completed", conclusion: "success" }],
          },
        ],
      });
    };
    expect(
      await evaluateBudget({
        repository: "owner/repo",
        token: "secret",
        workflowId: 10,
        boundaryRunId: scenario === "missing-boundary" ? 2 : 1,
        bindings: scenario === "missing-binding" ? [] : [{ runId: 1, pr: 7, budget: "command" }],
        request: { pr: 7, budget: "command" },
        fetch: fetcher,
      }),
    ).toEqual({ decision: "infra", reason: "github-history-unavailable-or-ambiguous" });
  },
);

it("loads all history pages and refuses inconsistent totals", async () => {
  let inconsistent = false;
  const fetcher: typeof fetch = async (url) => {
    const path = String(url);
    if (path.includes("/workflows/")) {
      const page = path.endsWith("page=1") ? 1 : 2;
      return Response.json({
        total_count: page === 2 && inconsistent ? 102 : 101,
        workflow_runs:
          page === 1
            ? Array.from({ length: 100 }, (_, i) => ({ id: i + 1, run_attempt: 1 }))
            : [{ id: 101, run_attempt: 1 }],
      });
    }
    return Response.json({ total_count: 0, jobs: [] });
  };
  const options = {
    repository: "owner/repo",
    token: "secret",
    workflowId: 10,
    boundaryRunId: 1,
    bindings: Array.from({ length: 101 }, (_, i) => ({
      runId: i + 1,
      pr: 7,
      budget: "review" as const,
    })),
    request: { pr: 7, budget: "review" as const },
    fetch: fetcher,
  };
  expect(await evaluateBudget(options)).toMatchObject({ used: 0, decision: "infra" });
  inconsistent = true;
  expect(await evaluateBudget(options)).toEqual({
    decision: "infra",
    reason: "github-history-unavailable-or-ambiguous",
  });
});

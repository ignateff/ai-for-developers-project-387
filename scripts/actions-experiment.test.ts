import { expect, it, vi } from "vitest";
import { inspectExperiment } from "./actions-experiment.ts";

const command = {
  action: "created",
  issue: { number: 7, pull_request: {} },
  comment: { body: "/oc go" },
};
const base = {
  repository: "owner/repo",
  token: "secret",
  workflowId: 12,
  boundaryRunId: 42,
  bindings: [{ runId: 42, pr: 7, budget: "command" as const }],
  event: "issue_comment",
  payload: command,
  trusted: true,
  kind: "full" as const,
};

it("reports a hypothetical exhausted command budget from Actions jobs without authorizing", async () => {
  const api = vi.fn(async (url: string | URL | Request) =>
    String(url).includes("/workflows/")
      ? Response.json({ total_count: 1, workflow_runs: [{ id: 42, run_attempt: 3 }] })
      : Response.json({
          total_count: 1,
          jobs: [
            {
              id: Number(String(url).match(/attempts\/(\d+)/)?.[1]),
              name: "model",
              steps: [{ name: "admission", status: "completed", conclusion: "success" }],
            },
          ],
        }),
  );
  expect(await inspectExperiment({ ...base, fetch: api })).toMatchObject({
    decision: "infra",
    reason: "admission-properties-unverified",
    hypothetical: "limit-exhausted",
    used: 3,
  });
  expect(api).toHaveBeenCalledTimes(4);
});

it.each([
  [{ ...base, trusted: false }, "untrusted"],
  [{ ...base, payload: { ...command, comment: { body: "hello" } } }, "not-a-candidate"],
  [{ ...base, payload: { ...command, issue: { number: 7 } } }, "not-a-candidate"],
  [{ ...base, kind: "publication" as const }, "publication-only"],
])("rejects non-admissions before reading history", async (input, reason) => {
  const api = vi.fn();
  expect(await inspectExperiment({ ...input, fetch: api })).toMatchObject({
    decision: "infra",
    reason,
  });
  expect(api).not.toHaveBeenCalled();
});

it("refuses inconsistent metadata for a repeated job across attempts", async () => {
  const api: typeof fetch = async (url) => {
    const path = String(url);
    if (path.includes("/workflows/"))
      return Response.json({ total_count: 1, workflow_runs: [{ id: 42, run_attempt: 2 }] });
    const success = path.includes("/attempts/1/");
    return Response.json({
      total_count: 1,
      jobs: [
        {
          id: 99,
          name: "model",
          steps: [
            { name: "admission", status: "completed", conclusion: success ? "success" : "failure" },
          ],
        },
      ],
    });
  };
  expect(await inspectExperiment({ ...base, fetch: api })).toMatchObject({
    decision: "infra",
    reason: "github-history-unavailable-or-ambiguous",
  });
});

it("keeps review and other PR usage separate from either comment channel", async () => {
  const api: typeof fetch = async (url) =>
    String(url).includes("/workflows/")
      ? Response.json({
          total_count: 3,
          workflow_runs: [
            { id: 42, run_attempt: 1 },
            { id: 43, run_attempt: 1 },
            { id: 44, run_attempt: 1 },
          ],
        })
      : Response.json({
          total_count: 1,
          jobs: [
            {
              id: Number(String(url).match(/runs\/(\d+)/)?.[1]),
              name: "model",
              conclusion: "cancelled",
              steps: [{ name: "admission", status: "completed", conclusion: "success" }],
            },
          ],
        });
  const options = {
    ...base,
    bindings: [
      { runId: 42, pr: 7, budget: "command" as const },
      { runId: 43, pr: 7, budget: "review" as const },
      { runId: 44, pr: 8, budget: "command" as const },
    ],
    fetch: api,
  };
  expect(
    await inspectExperiment({
      ...options,
      event: "pull_request_review_comment",
      payload: {
        action: "created",
        pull_request: { number: 7 },
        comment: { body: "/opencode go" },
      },
    }),
  ).toMatchObject({ used: 1, binding: { pr: 7, budget: "command" } });
  expect(
    await inspectExperiment({
      ...options,
      event: "pull_request",
      payload: { action: "reopened", pull_request: { number: 7, draft: false } },
    }),
  ).toMatchObject({ used: 1, binding: { pr: 7, budget: "review" } });
});

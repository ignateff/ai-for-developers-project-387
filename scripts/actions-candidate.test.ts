import { expect, it, vi } from "vitest";
import { inspectCandidate } from "./actions-candidate.ts";

it("binds a comment payload and reads Actions history without authorizing a model", async () => {
  const urls: string[] = [];
  const result = await inspectCandidate({
    repository: "owner/repo",
    workflowId: 12,
    boundaryRunId: 42,
    bindings: [{ runId: 42, pr: 7, budget: "command" }],
    event: "issue_comment",
    payload: {
      action: "created",
      issue: { number: 7, pull_request: {} },
      comment: { body: "/oc go" },
    },
    token: "secret",
    fetch: async (url) => {
      urls.push(String(url));
      return String(url).includes("/workflows/")
        ? Response.json({ total_count: 1, workflow_runs: [{ id: 42, run_attempt: 1 }] })
        : Response.json({
            total_count: 1,
            jobs: [
              {
                id: 9,
                name: "model",
                steps: [{ name: "admission", status: "completed", conclusion: "success" }],
              },
            ],
          });
    },
  });
  expect(result).toMatchObject({
    decision: "infra",
    reason: "admission-properties-unverified",
    binding: { pr: 7, budget: "command" },
    used: 1,
    hypothetical: "would-admit",
  });
  expect(urls).toEqual([
    "https://api.github.com/repos/owner/repo/actions/workflows/12/runs?per_page=100&page=1",
    "https://api.github.com/repos/owner/repo/actions/runs/42/attempts/1/jobs?per_page=100&page=1",
  ]);
});

it.each([
  [
    "pull_request_review_comment",
    { action: "created", pull_request: { number: 8 }, comment: { body: "/opencode go" } },
    { pr: 8, budget: "command" },
  ],
  [
    "pull_request",
    { action: "synchronize", pull_request: { number: 8, draft: false } },
    { pr: 8, budget: "review" },
  ],
])(
  "reports the candidate binding for %s even when history is unavailable",
  async (event, payload, binding) => {
    const result = await inspectCandidate({
      repository: "owner/repo",
      workflowId: 12,
      boundaryRunId: 42,
      bindings: [],
      event,
      payload,
      token: "secret",
      fetch: async () => new Response(null, { status: 503 }),
    });
    expect(result).toEqual({
      decision: "infra",
      reason: "github-history-unavailable-or-ambiguous",
      binding,
    });
  },
);

it("does not query history for an ordinary issue comment", async () => {
  const fetch = vi.fn();
  const result = await inspectCandidate({
    repository: "owner/repo",
    workflowId: 12,
    boundaryRunId: 42,
    bindings: [],
    event: "issue_comment",
    payload: { action: "created", issue: { number: 7 }, comment: { body: "/oc go" } },
    token: "secret",
    fetch,
  });
  expect(result).toEqual({ decision: "infra", reason: "not-a-candidate" });
  expect(fetch).not.toHaveBeenCalled();
});

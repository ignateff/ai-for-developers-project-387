import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { inspectGate } from "./actions-gate.ts";

const payload = {
  action: "created",
  repository: { full_name: "owner/repo", owner: { login: "owner" } },
  issue: { number: 7, pull_request: {} },
  comment: { body: "/oc review", user: { login: "owner" } },
};
const base = {
  repository: "owner/repo",
  owner: "owner",
  token: "secret",
  workflowId: 5,
  currentRunId: 99,
  boundaryRunId: 10,
  event: "issue_comment",
  payload,
};
const pr = {
  number: 7,
  base: { repo: { id: 1, full_name: "owner/repo" } },
  head: { repo: { id: 1, full_name: "owner/repo" } },
};

it("keeps the example marker metadata-only and fails the job independently", () => {
  const workflow = parse(
    readFileSync("docs/agents/actions-admission.workflow.yml.example", "utf8"),
  );
  const steps = workflow.jobs.metadata.steps as Array<Record<string, string>>;
  const inspect = steps.find((step) => step.id === "inspect");
  const marker = steps.find((step) => step.name === "admission");
  const failure = steps.find((step) => step.name === "fail closed");
  expect(inspect).toMatchObject({
    run: "node scripts/actions-gate-cli.ts",
    "continue-on-error": true,
  });
  expect(marker).toEqual({
    name: "admission",
    if: "${{ steps.inspect.outputs.metadata_candidate == 'would-admit' }}",
    run: 'echo "Metadata-only hypothetical marker; no model access"',
  });
  expect(failure).toEqual({ name: "fail closed", if: "${{ always() }}", run: "exit 1" });
  expect(steps.indexOf(marker!)).toBeLessThan(steps.indexOf(failure!));
  expect(steps.filter((step) => step.run).map((step) => step.run)).toEqual([
    inspect!.run,
    marker!.run,
    failure!.run,
  ]);
});

describe("metadata gate public behavior", () => {
  it.each([0, 3, 4])("reports %i matching markers hypothetically, never admits", async (count) => {
    const github = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      const url = String(input);
      if (url.endsWith("/pulls/7")) return Response.json(pr);
      if (url.includes("/workflows/5/runs?"))
        return Response.json({
          total_count: count + 1,
          workflow_runs: [
            { id: 10 },
            ...Array.from({ length: count }, (_, i) => ({
              id: 11 + i,
              run_attempt: 1,
              status: "completed",
            })),
          ],
        });
      if (url.endsWith("/runs/99")) return Response.json({ id: 99, workflow_id: 5 });
      if (url.includes("/attempts/1/jobs?"))
        return Response.json({
          total_count: 1,
          jobs: [
            {
              id: Number(url.match(/runs\/(\d+)/)?.[1]),
              name: "budget-model / command / pr-7",
              status: "completed",
              steps: [{ name: "admission", status: "completed", conclusion: "success" }],
            },
          ],
        });
      throw Error("unexpected URL");
    });
    const result = await inspectGate({ ...base, fetch: github });
    expect(result).toMatchObject({
      decision: "infra",
      reason: "admission-properties-unverified",
      used: count,
      hypothetical: count >= 3 ? "limit-exhausted" : "would-admit",
    });
  });
  it("shares the command budget for review comments", async () => {
    const github = vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith("/pulls/7")
        ? Response.json(pr)
        : String(input).endsWith("/runs/99")
          ? Response.json({ id: 99, workflow_id: 5 })
          : Response.json({ total_count: 1, workflow_runs: [{ id: 10 }] }),
    );
    const result = await inspectGate({
      ...base,
      event: "pull_request_review_comment",
      payload: { ...payload, pull_request: { number: 7 } },
      fetch: github,
    });
    expect(result).toMatchObject({
      decision: "infra",
      binding: { pr: 7, budget: "command" },
      used: 0,
    });
  });
  it.each([
    { ...payload, issue: { number: 7 } },
    { ...payload, comment: { ...payload.comment, body: "hello" } },
  ])("skips non-candidates without network", async (event) => {
    const github = vi.fn();
    expect(await inspectGate({ ...base, payload: event, fetch: github })).toEqual({
      decision: "skip",
      reason: "not-a-candidate",
    });
    expect(github).not.toHaveBeenCalled();
  });
  it("does not trust review events without a trust policy", async () => {
    expect(
      await inspectGate({
        ...base,
        event: "pull_request",
        payload: { action: "opened", pull_request: { number: 7, draft: false } },
      }),
    ).toEqual({ decision: "infra", reason: "review-trust-unverified" });
  });
  it("fails closed on API failure and fork PR", async () => {
    expect(
      await inspectGate({ ...base, fetch: async () => new Response("secret", { status: 500 }) }),
    ).toEqual({ decision: "infra", reason: "trust-unavailable" });
    expect(
      await inspectGate({
        ...base,
        fetch: async () =>
          Response.json({ ...pr, head: { repo: { id: 2, full_name: "fork/repo" } } }),
      }),
    ).toEqual({ decision: "skip", reason: "untrusted" });
  });
  it("fails closed when history boundary is missing", async () => {
    const github = async (input: string | URL | Request) =>
      String(input).endsWith("/pulls/7")
        ? Response.json(pr)
        : String(input).endsWith("/runs/99")
          ? Response.json({ id: 99, workflow_id: 5 })
          : Response.json({ total_count: 0, workflow_runs: [] });
    expect(await inspectGate({ ...base, fetch: github })).toEqual({
      decision: "infra",
      reason: "github-history-unavailable-or-ambiguous",
    });
  });
  it.each([{ id: 99, workflow_id: 6 }, { id: 98, workflow_id: 5 }, {}])(
    "rejects an unverified current workflow",
    async (run) => {
      const fetch = async (input: string | URL | Request) =>
        String(input).endsWith("/pulls/7") ? Response.json(pr) : Response.json(run);
      expect(await inspectGate({ ...base, fetch })).toEqual({
        decision: "infra",
        reason: "current-workflow-unverified",
      });
    },
  );
});

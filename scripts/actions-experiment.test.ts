import { expect, it } from "vitest";
import { createExperiment, createExperimentClient } from "./actions-experiment.ts";

it("allocates fixture evidence before fake runtime preparation", async () => {
  const experiment = createExperiment();
  const result = await experiment.dispatch({
    runId: 1,
    kind: "full",
    event: "issue_comment",
    payload: {
      action: "created",
      issue: { number: 7, pull_request: {} },
      comment: { body: "/oc review" },
    },
    trusted: true,
    runtime: "prepare-fails",
  });
  expect(result).toMatchObject({ decision: "admitted", outcome: "prepare-fails", used: 1 });
  expect(await experiment.history()).toMatchObject([{ pr: 7, budget: "command", runId: 1 }]);
});

it("fails closed when the fixture API cannot confirm allocation", async () => {
  const client = createExperimentClient(async () => new Response(null, { status: 503 }));
  const result = await client.dispatch({
    runId: 1,
    kind: "full",
    event: "issue_comment",
    payload: {
      action: "created",
      issue: { number: 7, pull_request: {} },
      comment: { body: "/oc go" },
    },
    trusted: true,
  });
  expect(result).toEqual({ decision: "infra", reason: "fixture-api-unavailable" });
});

it("shares command budget across comment channels while review has a separate budget", async () => {
  const experiment = createExperiment();
  const issue = {
    action: "created",
    issue: { number: 7, pull_request: {} },
    comment: { body: "/oc go" },
  };
  const line = {
    action: "created",
    pull_request: { number: 7 },
    comment: { body: "/opencode go" },
  };
  const send = (runId: number, event: string, payload: unknown) =>
    experiment.dispatch({ runId, kind: "full", event, payload, trusted: true });
  expect((await send(1, "issue_comment", issue)).decision).toBe("admitted");
  expect((await send(2, "pull_request_review_comment", line)).decision).toBe("admitted");
  expect((await send(3, "issue_comment", issue)).decision).toBe("admitted");
  expect(await send(4, "issue_comment", issue)).toMatchObject({ decision: "denied", used: 3 });
  expect(await send(5, "issue_comment", issue)).toMatchObject({ decision: "denied", used: 3 });
  expect(
    await send(6, "pull_request", {
      action: "synchronize",
      pull_request: { number: 7, draft: false },
    }),
  ).toMatchObject({ decision: "admitted", used: 1 });
  expect(await experiment.history()).toHaveLength(4);
});

it("does not consume for untrusted, ordinary, issue, or draft events", async () => {
  const experiment = createExperiment();
  const base = { runId: 1, kind: "full" as const, event: "issue_comment", trusted: true };
  const command = {
    action: "created",
    issue: { number: 7, pull_request: {} },
    comment: { body: "/oc go" },
  };
  expect((await experiment.dispatch({ ...base, payload: command, trusted: false })).decision).toBe(
    "denied",
  );
  expect(
    (await experiment.dispatch({ ...base, payload: { ...command, comment: { body: "hello" } } }))
      .decision,
  ).toBe("skipped");
  expect(
    (await experiment.dispatch({ ...base, payload: { ...command, issue: { number: 7 } } }))
      .decision,
  ).toBe("skipped");
  expect(
    (
      await experiment.dispatch({
        ...base,
        event: "pull_request",
        payload: { action: "opened", pull_request: { number: 7, draft: true } },
      })
    ).decision,
  ).toBe("skipped");
  expect(await experiment.history()).toEqual([]);
});

it("serializes competing admissions and charges cancellation and model reruns, not publication", async () => {
  const experiment = createExperiment();
  const request = {
    runId: 10,
    kind: "full" as const,
    event: "issue_comment",
    payload: {
      action: "created",
      issue: { number: 7, pull_request: {} },
      comment: { body: "/oc go" },
    },
    trusted: true,
  };
  await experiment.dispatch({ ...request, runtime: "cancelled" });
  await experiment.dispatch({ ...request, kind: "model", runtime: "timeout" });
  expect((await experiment.dispatch({ ...request, kind: "publication" })).decision).toBe("skipped");
  const results = await Promise.all([experiment.dispatch(request), experiment.dispatch(request)]);
  expect(results.map((r) => r.decision).sort()).toEqual(["admitted", "denied"]);
  expect(await experiment.history()).toHaveLength(3);
});

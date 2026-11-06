import { expect, test } from "vitest";
import { createProductionWorkflow } from "./opencode-production-workflow";

test("production review adapter spends before preparing and reruns never reuse admission", async () => {
  const comments: { id: number; user: { id: number }; body: string }[] = [];
  let id = 1;
  const order: string[] = [];
  const api: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/pulls/"))
      return Response.json({
        number: 7,
        state: "open",
        draft: false,
        user: { type: "User", login: "owner" },
        base: { repo: { id: 1, full_name: "owner/repo" } },
        head: { repo: { id: 1, full_name: "owner/repo" }, sha: "a".repeat(40) },
      });
    if (init?.method === "POST") {
      const c = { id: id++, user: { id: 42 }, body: JSON.parse(String(init.body)).body };
      comments.push(c);
      return Response.json(c, { status: 201 });
    }
    const index = comments.findIndex((c) => c.id === Number(url.match(/comments\/(\d+)/)?.[1]));
    if (init?.method === "DELETE") {
      comments.splice(index, 1);
      return new Response(null, { status: 204 });
    }
    if (init?.method === "PATCH") {
      comments[index].body = JSON.parse(String(init.body)).body;
      order.push("budget");
      return Response.json(comments[index]);
    }
    return Response.json(comments);
  };
  const run = createProductionWorkflow({
    fetch: api,
    prepare: async () => {
      order.push("prepare");
    },
    model: async (identity) => {
      expect(identity.sha).toBe("a".repeat(40));
      order.push("model");
    },
  });
  const options = {
    kind: "review" as const,
    eventName: "pull_request",
    event: {
      action: "opened",
      repository: { full_name: "owner/repo" },
      pull_request: { number: 7 },
    },
    repository: "owner/repo",
    owner: "owner",
    token: "token",
    authorId: 42,
    actionsUrl: "https://github.com/owner/repo/actions/runs/1",
  };
  for (let attempt = 0; attempt < 3; attempt++)
    expect((await run(options)).status).toBe("completed");
  expect((await run(options)).status).toBe("limit_exhausted");
  expect(order).toEqual([
    "budget",
    "prepare",
    "model",
    "budget",
    "prepare",
    "model",
    "budget",
    "prepare",
    "model",
  ]);
  expect(comments).toHaveLength(1);
  expect(comments[0].body).toContain('"review":3');
  const repository = { full_name: "owner/repo", owner: { login: "owner" } };
  const comment = { body: "/oc fix", user: { type: "User", login: "owner" } };
  const common = {
    ...options,
    kind: "command" as const,
    eventName: "issue_comment",
    event: { action: "created", repository, issue: { number: 7, pull_request: {} }, comment },
  };
  const inline = {
    ...common,
    eventName: "pull_request_review_comment",
    event: { action: "created", repository, pull_request: { number: 7 }, comment },
  };
  expect((await run(common)).status).toBe("completed");
  expect((await run(inline)).status).toBe("completed");
  expect((await run(common)).status).toBe("completed");
  expect((await run(inline)).status).toBe("limit_exhausted");
  expect(comments[0].body).toContain('"command":3,"review":3');
  const before = [...order];
  expect(
    (
      await run({
        ...common,
        event: { ...common.event, comment: { ...comment, body: "ordinary text" } },
      })
    ).status,
  ).toBe("skipped");
  expect(order).toEqual(before);
  comments.splice(0);
  let modelCalls = 0;
  const failing = createProductionWorkflow({
    fetch: api,
    prepare: async () => {
      throw Error("secret");
    },
    model: async () => {
      modelCalls++;
    },
  });
  for (let attempt = 0; attempt < 3; attempt++)
    expect(await failing(options)).toEqual({ status: "infra", number: 7 });
  expect((await failing(options)).status).toBe("limit_exhausted");
  expect(modelCalls).toBe(0);
  expect(comments[0].body).toContain('"review":3');
  comments.splice(0);
  const timeout = createProductionWorkflow({
    fetch: api,
    prepare: async () => {},
    model: async () => {
      modelCalls++;
      throw Error("timeout secret");
    },
  });
  expect(await timeout(options)).toEqual({ status: "infra", number: 7 });
  expect((await timeout(options)).status).toBe("infra");
  expect(comments[0].body).toContain('"review":2');
  expect(modelCalls).toBe(2);
});

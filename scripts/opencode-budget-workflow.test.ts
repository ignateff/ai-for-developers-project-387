import { expect, test } from "vitest";
import { createBudgetWorkflow } from "./opencode-budget-workflow";

test("command and review attempts share a comment but have independent limits", async () => {
  let body = "";
  let calls = 0;
  const api: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/pulls/"))
      return Response.json({
        number: 7,
        draft: false,
        user: { login: "owner", type: "User" },
        base: { repo: { id: 1, full_name: "owner/repo" } },
        head: { repo: { id: 1, full_name: "owner/repo" }, sha: "a".repeat(40) },
      });
    if (init?.method === "POST" || init?.method === "PATCH") {
      body = JSON.parse(String(init.body)).body;
      return Response.json(
        { id: 10, user: { id: 42 }, body },
        { status: init.method === "POST" ? 201 : 200 },
      );
    }
    return Response.json(body ? [{ id: 10, user: { id: 42 }, body }] : []);
  };
  const run = createBudgetWorkflow({
    fetch: api,
    prepare: async () => {},
    model: async () => {
      calls++;
    },
  });
  const event = {
    action: "created",
    repository: { full_name: "owner/repo", owner: { login: "owner" } },
    issue: { number: 7, pull_request: {} },
    comment: { body: "/oc fix", user: { login: "owner", type: "User" } },
  };
  const base = {
    repository: "owner/repo",
    owner: "owner",
    token: "token",
    authorId: 42,
    actionsUrl: "https://github.com/owner/repo/actions/runs/1",
  };
  for (let i = 0; i < 3; i++)
    expect(
      (await run({ ...base, kind: "command", eventName: "issue_comment", event })).status,
    ).toBe("completed");
  expect((await run({ ...base, kind: "command", eventName: "issue_comment", event })).status).toBe(
    "limit_exhausted",
  );
  const review = { action: "opened", repository: event.repository, pull_request: { number: 7 } };
  expect(
    (await run({ ...base, kind: "review", eventName: "pull_request", event: review })).status,
  ).toBe("completed");
  expect(body).toContain('"command":3');
  expect(body).toContain('"review":1');
  expect(calls).toBe(4);
});

test("failed preparation spends an attempt, reruns spend again, publication does not", async () => {
  let body = "";
  let calls = 0;
  let published = 0;
  const api: typeof fetch = async (input, init) => {
    if (String(input).includes("/pulls/"))
      return Response.json({
        number: 7,
        draft: false,
        user: { type: "User", login: "owner" },
        base: { repo: { id: 1, full_name: "owner/repo" } },
        head: { repo: { id: 1, full_name: "owner/repo" }, sha: "b".repeat(40) },
      });
    if (init?.method === "POST" || init?.method === "PATCH") {
      body = JSON.parse(String(init.body)).body;
      return Response.json({ id: 10, user: { id: 42 }, body });
    }
    return Response.json(body ? [{ id: 10, user: { id: 42 }, body }] : []);
  };
  const run = createBudgetWorkflow({
    fetch: api,
    prepare: async () => {
      throw Error("secret");
    },
    model: async () => {
      calls++;
    },
    publish: async () => {
      published++;
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
  for (let i = 0; i < 3; i++) expect(await run(options)).toEqual({ status: "infra", number: 7 });
  const exhausted = await run(options);
  expect(exhausted).toEqual({
    status: "limit_exhausted",
    number: 7,
    sha: "b".repeat(40),
    actionsUrl: options.actionsUrl,
  });
  expect(await run(options)).toEqual(exhausted);
  expect(await run({ ...options, publicationOnly: true })).toEqual({ status: "published" });
  expect(body).toContain('"review":3');
  expect(calls).toBe(0);
  expect(published).toBe(1);
});

test.each(["error", "corrupt", "duplicate"])("%s comment state fails closed", async (problem) => {
  let model = 0;
  const marker = "<!-- opencode-pr-attempt-budget:v1 -->";
  const comment = {
    id: 10,
    user: { id: 42 },
    body: `${marker}\n${problem === "corrupt" ? "broken" : '{"command":0,"review":0}'}`,
  };
  const api: typeof fetch = async (input) => {
    if (String(input).includes("/pulls/"))
      return Response.json({
        number: 7,
        draft: false,
        user: { type: "User", login: "owner" },
        base: { repo: { id: 1, full_name: "owner/repo" } },
        head: { repo: { id: 1, full_name: "owner/repo" }, sha: "c".repeat(40) },
      });
    if (problem === "error") throw Error("secret from github");
    return Response.json(problem === "duplicate" ? [comment, comment] : [comment]);
  };
  const run = createBudgetWorkflow({
    fetch: api,
    prepare: async () => {},
    model: async () => {
      model++;
    },
  });
  expect(
    await run({
      kind: "review",
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
      actionsUrl: "unsafe",
    }),
  ).toEqual({ status: "infra", number: 7 });
  expect(model).toBe(0);
});

test("paginates and serializes simultaneous review and command updates within the process", async () => {
  let body = '<!-- opencode-pr-attempt-budget:v1 -->\n{"command":0,"review":0}';
  let calls = 0;
  let secondPage = 0;
  const api: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/pulls/"))
      return Response.json({
        number: 7,
        draft: false,
        user: { type: "User", login: "owner" },
        base: { repo: { id: 1, full_name: "owner/repo" } },
        head: { repo: { id: 1, full_name: "owner/repo" }, sha: "a".repeat(40) },
      });
    if (init?.method === "PATCH") {
      body = JSON.parse(String(init.body)).body;
      return Response.json({});
    }
    if (new URL(url).searchParams.get("page") === "1")
      return Response.json(
        Array.from({ length: 100 }, (_, id) => ({ id, user: { id: 1 }, body: "ordinary" })),
      );
    secondPage++;
    return Response.json([{ id: 10, user: { id: 42 }, body }]);
  };
  const run = createBudgetWorkflow({
    fetch: api,
    prepare: async () => {},
    model: async () => {
      calls++;
    },
  });
  const base = {
    repository: "owner/repo",
    owner: "owner",
    token: "token",
    authorId: 42,
    actionsUrl: "https://github.com/owner/repo/actions/runs/1",
  };
  const repo = { full_name: "owner/repo", owner: { login: "owner" } };
  const results = await Promise.all([
    run({
      ...base,
      kind: "command",
      eventName: "pull_request_review_comment",
      event: {
        action: "created",
        repository: repo,
        pull_request: { number: 7 },
        comment: { body: "/oc fix", user: { login: "owner", type: "User" } },
      },
    }),
    run({
      ...base,
      kind: "review",
      eventName: "pull_request",
      event: { action: "opened", repository: repo, pull_request: { number: 7 } },
    }),
  ]);
  expect(results.map((result) => result.status)).toEqual(["completed", "completed"]);
  expect(body).toContain('"command":1,"review":1');
  expect(secondPage).toBe(2);
  expect(calls).toBe(2);
});

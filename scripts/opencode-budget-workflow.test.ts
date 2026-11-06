import { expect, test } from "vitest";
import { createBudgetWorkflow } from "./opencode-budget-workflow";
import { createCommentBudgetLock } from "./opencode-budget-lock";

test("production adapter supplies the admitted PR identity to runtime after the budget write", async () => {
  const events: string[] = [];
  let body = "";
  const api: typeof fetch = async (input, init) => {
    if (String(input).includes("/pulls/"))
      return Response.json({
        number: 7,
        state: "open",
        draft: false,
        user: { type: "User", login: "owner" },
        base: { repo: { id: 1, full_name: "owner/repo" } },
        head: { repo: { id: 1, full_name: "owner/repo" }, sha: "a".repeat(40) },
      });
    if (init?.method === "POST" || init?.method === "PATCH") {
      body = JSON.parse(String(init.body)).body;
      if (init.method === "PATCH") events.push("budget");
      return Response.json({ id: 10, user: { id: 42 }, body });
    }
    return Response.json(body ? [{ id: 10, user: { id: 42 }, body }] : []);
  };
  const run = createBudgetWorkflow({
    fetch: api,
    prepare: async () => {
      events.push("prepare");
    },
    model: async (identity) => {
      expect(identity).toEqual({ number: 7, sha: "a".repeat(40) });
      events.push("model");
    },
  });
  const result = await run({
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
    actionsUrl: "",
  });
  expect(result.status).toBe("completed");
  expect(events).toEqual(["budget", "prepare", "model"]);
});

test("command and review attempts share a comment but have independent limits", async () => {
  let body = "";
  let calls = 0;
  const api: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/pulls/"))
      return Response.json({
        number: 7,
        state: "open",
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
  expect((await run({ ...base, kind: "command", eventName: "issue_comment", event })).status).toBe(
    "completed",
  );
  const inline = {
    action: "created",
    repository: event.repository,
    pull_request: { number: 7 },
    comment: event.comment,
  };
  expect(
    (
      await run({
        ...base,
        kind: "command",
        eventName: "pull_request_review_comment",
        event: inline,
      })
    ).status,
  ).toBe("completed");
  expect((await run({ ...base, kind: "command", eventName: "issue_comment", event })).status).toBe(
    "completed",
  );
  expect((await run({ ...base, kind: "command", eventName: "issue_comment", event })).status).toBe(
    "limit_exhausted",
  );
  const review = { action: "opened", repository: event.repository, pull_request: { number: 7 } };
  for (let i = 0; i < 3; i++)
    expect(
      (await run({ ...base, kind: "review", eventName: "pull_request", event: review })).status,
    ).toBe("completed");
  expect(
    (await run({ ...base, kind: "review", eventName: "pull_request", event: review })).status,
  ).toBe("limit_exhausted");
  expect(body).toContain('"command":3');
  expect(body).toContain('"review":3');
  expect(calls).toBe(6);
});

test("the shared comment lock is released before the first model finishes", async () => {
  let nextId = 1;
  const comments: { id: number; user: { id: number }; body: string }[] = [];
  let releaseModel!: () => void;
  let modelStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    modelStarted = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    releaseModel = resolve;
  });
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
      const item = { id: nextId++, user: { id: 42 }, body: JSON.parse(String(init.body)).body };
      comments.push(item);
      return Response.json(item, { status: 201 });
    }
    const id = Number(url.match(/comments\/(\d+)/)?.[1]);
    if (init?.method === "DELETE") {
      const i = comments.findIndex((c) => c.id === id);
      if (i < 0) return new Response(null, { status: 404 });
      comments.splice(i, 1);
      return new Response(null, { status: 204 });
    }
    if (init?.method === "PATCH") {
      const c = comments.find((item) => item.id === id)!;
      c.body = JSON.parse(String(init.body)).body;
      return Response.json(c);
    }
    return Response.json(comments);
  };
  const withLock = createCommentBudgetLock({
    fetch: api,
    repository: "owner/repo",
    token: "token",
    authorId: 42,
    delay: async () => {},
  });
  const first = createBudgetWorkflow({
    fetch: api,
    withLock,
    prepare: async () => {},
    model: async () => {
      modelStarted();
      await blocked;
    },
  });
  const second = createBudgetWorkflow({
    fetch: api,
    withLock,
    prepare: async () => {},
    model: async () => {},
  });
  const base = {
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
    actionsUrl: "",
  };
  const running = first(base);
  await started;
  expect((await second(base)).status).toBe("completed");
  expect(comments).toHaveLength(1);
  expect(comments[0].body).toContain('"review":2');
  releaseModel();
  expect((await running).status).toBe("completed");
});

test("a prior cross-runner claim delays admission and failed lock cleanup blocks runtime", async () => {
  const marker = "<!-- opencode-pr-budget-lock:v1 -->";
  const comments = [
    { id: 1, user: { id: 42 }, body: `${marker}\n00000000-0000-4000-8000-000000000000` },
  ];
  let nextId = 2;
  let waited = 0;
  let prepared = false;
  let countWritten = false;
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
      const c = { id: nextId++, user: { id: 42 }, body: JSON.parse(String(init.body)).body };
      comments.push(c);
      return Response.json(c, { status: 201 });
    }
    if (init?.method === "PATCH") {
      countWritten = true;
      return Response.json({});
    }
    if (init?.method === "DELETE") return new Response(null, { status: 503 });
    return Response.json(comments);
  };
  const withLock = createCommentBudgetLock({
    fetch: api,
    repository: "owner/repo",
    token: "token",
    authorId: 42,
    delay: async () => {
      waited++;
      comments.shift();
    },
  });
  const run = createBudgetWorkflow({
    fetch: api,
    withLock,
    prepare: async () => {
      prepared = true;
    },
    model: async () => {},
  });
  const result = await run({
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
    actionsUrl: "",
  });
  expect(waited).toBe(1);
  expect(countWritten).toBe(true);
  expect(result.status).toBe("infra");
  expect(prepared).toBe(false);
});

test("failed preparation spends an attempt and reruns spend again", async () => {
  let body = "";
  let calls = 0;
  const api: typeof fetch = async (input, init) => {
    if (String(input).includes("/pulls/"))
      return Response.json({
        number: 7,
        state: "open",
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
  expect(body).toContain('"review":3');
  expect(calls).toBe(0);
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
        state: "open",
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
        state: "open",
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

test.each(["text", "bot", "fork", "draft", "closed", "permission-error"])(
  "%s is rejected before budget or runtime",
  async (caseName) => {
    let budgetCalls = 0;
    let modelCalls = 0;
    const repository = { full_name: "owner/repo", owner: { login: "owner" } };
    const pr = {
      number: 7,
      state: caseName === "closed" ? "closed" : "open",
      draft: caseName === "draft",
      user: { type: "User", login: caseName === "permission-error" ? "writer" : "owner" },
      base: { repo: { id: 1, full_name: "owner/repo" } },
      head: {
        repo: { id: caseName === "fork" ? 2 : 1, full_name: "owner/repo" },
        sha: "a".repeat(40),
      },
    };
    const api: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/pulls/")) return Response.json(pr);
      if (url.includes("/permission")) throw Error("secret");
      budgetCalls++;
      return Response.json([]);
    };
    const run = createBudgetWorkflow({
      fetch: api,
      prepare: async () => {
        throw Error("should not prepare");
      },
      model: async () => {
        modelCalls++;
      },
    });
    const base = {
      repository: "owner/repo",
      owner: "owner",
      token: "token",
      authorId: 42,
      actionsUrl: "https://github.com/owner/repo/actions/runs/1",
    };
    const command = caseName === "text" || caseName === "bot" || caseName === "fork";
    const result = command
      ? await run({
          ...base,
          kind: "command",
          eventName: "issue_comment",
          event: {
            action: "created",
            repository,
            issue: { number: 7, pull_request: {} },
            comment: {
              body: caseName === "text" ? "hello" : "/oc fix",
              user: { login: "owner", type: caseName === "bot" ? "Bot" : "User" },
            },
          },
        })
      : await run({
          ...base,
          kind: "review",
          eventName: "pull_request",
          event: { action: "opened", repository, pull_request: { number: 7 } },
        });
    expect(result.status).toBe(caseName === "permission-error" ? "infra" : "skipped");
    expect(budgetCalls).toBe(0);
    expect(modelCalls).toBe(0);
  },
);

test("ordinary issue commands bypass PR comment storage", async () => {
  let model = 0;
  const run = createBudgetWorkflow({
    fetch: async () => {
      throw Error("unexpected API call");
    },
    prepare: async () => {},
    model: async () => {
      model++;
    },
  });
  const result = await run({
    kind: "command",
    eventName: "issue_comment",
    event: {
      action: "created",
      repository: { full_name: "owner/repo", owner: { login: "owner" } },
      issue: { number: 7 },
      comment: { body: "/oc fix", user: { type: "User", login: "owner" } },
    },
    repository: "owner/repo",
    owner: "owner",
    token: "token",
    authorId: 42,
    actionsUrl: "",
  });
  expect(result.status).toBe("completed");
  expect(model).toBe(1);
});

test("deleted budget is recreated; a marker from another author never counts as state", async () => {
  let body = "";
  let creations = 0;
  let calls = 0;
  const api: typeof fetch = async (input, init) => {
    if (String(input).includes("/pulls/"))
      return Response.json({
        number: 7,
        state: "open",
        draft: false,
        user: { type: "User", login: "owner" },
        base: { repo: { id: 1, full_name: "owner/repo" } },
        head: { repo: { id: 1, full_name: "owner/repo" }, sha: "a".repeat(40) },
      });
    if (init?.method === "POST" || init?.method === "PATCH") {
      body = JSON.parse(String(init.body)).body;
      if (init.method === "POST") creations++;
      return Response.json({ id: 10, user: { id: 42 }, body });
    }
    const spoof = {
      id: 11,
      user: { id: 99 },
      body: '<!-- opencode-pr-attempt-budget:v1 -->\n{"command":3,"review":3}',
    };
    return Response.json(body ? [spoof, { id: 10, user: { id: 42 }, body }] : [spoof]);
  };
  const run = createBudgetWorkflow({
    fetch: api,
    prepare: async () => {},
    model: async () => {
      calls++;
    },
  });
  const options = {
    kind: "review" as const,
    eventName: "pull_request",
    event: {
      action: "reopened",
      repository: { full_name: "owner/repo" },
      pull_request: { number: 7 },
    },
    repository: "owner/repo",
    owner: "owner",
    token: "token",
    authorId: 42,
    actionsUrl: "https://github.com/owner/repo/actions/runs/1",
  };
  expect((await run(options)).status).toBe("completed");
  body = ""; // human deleted the comment; the old history is intentionally not recovered
  expect((await run(options)).status).toBe("completed");
  expect(body).toContain('"review":1');
  expect(creations).toBe(2);
  expect(calls).toBe(2);
});

test.each(["create", "update"])(
  "GitHub %s error is infra and prevents runtime",
  async (failure) => {
    let prepared = false;
    const body = '<!-- opencode-pr-attempt-budget:v1 -->\n{"command":0,"review":0}';
    const api: typeof fetch = async (input, init) => {
      if (String(input).includes("/pulls/"))
        return Response.json({
          number: 7,
          state: "open",
          draft: false,
          user: { type: "User", login: "owner" },
          base: { repo: { id: 1, full_name: "owner/repo" } },
          head: { repo: { id: 1, full_name: "owner/repo" }, sha: "a".repeat(40) },
        });
      if (init?.method === "POST" || init?.method === "PATCH")
        return new Response("secret", { status: 503 });
      return Response.json(failure === "create" ? [] : [{ id: 10, user: { id: 42 }, body }]);
    };
    const run = createBudgetWorkflow({
      fetch: api,
      prepare: async () => {
        prepared = true;
      },
      model: async () => {},
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
        token: "secret",
        authorId: 42,
        actionsUrl: "",
      }),
    ).toEqual({ status: "infra", number: 7 });
    expect(prepared).toBe(false);
  },
);

test("timeout after admission consumes the attempt without exposing diagnostics", async () => {
  let body = '<!-- opencode-pr-attempt-budget:v1 -->\n{"command":0,"review":2}';
  const api: typeof fetch = async (input, init) => {
    if (String(input).includes("/pulls/"))
      return Response.json({
        number: 7,
        state: "open",
        draft: false,
        user: { type: "User", login: "owner" },
        base: { repo: { id: 1, full_name: "owner/repo" } },
        head: { repo: { id: 1, full_name: "owner/repo" }, sha: "a".repeat(40) },
      });
    if (init?.method === "PATCH") {
      body = JSON.parse(String(init.body)).body;
      return Response.json({});
    }
    return Response.json([{ id: 10, user: { id: 42 }, body }]);
  };
  const run = createBudgetWorkflow({
    fetch: api,
    prepare: async () => {},
    model: async () => {
      throw Error("timeout secret");
    },
  });
  const options = {
    kind: "review" as const,
    eventName: "pull_request",
    event: {
      action: "synchronize",
      repository: { full_name: "owner/repo" },
      pull_request: { number: 7 },
    },
    repository: "owner/repo",
    owner: "owner",
    token: "secret",
    authorId: 42,
    actionsUrl: "https://github.com/owner/repo/actions/runs/1",
  };
  expect(await run(options)).toEqual({ status: "infra", number: 7 });
  expect((await run(options)).status).toBe("limit_exhausted");
  expect(body).toContain('"review":3');
});

test.each([
  [55, "completed"],
  [56, "skipped"],
] as const)("review bot %s is accepted only by numeric allowlist", async (id, status) => {
  let body = "";
  const api: typeof fetch = async (input, init) => {
    if (String(input).includes("/pulls/"))
      return Response.json({
        number: 7,
        state: "open",
        draft: false,
        user: { type: "Bot", login: "agent[bot]", id },
        base: { repo: { id: 1, full_name: "owner/repo" } },
        head: { repo: { id: 1, full_name: "owner/repo" }, sha: "a".repeat(40) },
      });
    if (init?.method === "POST" || init?.method === "PATCH") {
      body = JSON.parse(String(init.body)).body;
      return Response.json({ id: 10, user: { id: 42 }, body });
    }
    return Response.json([]);
  };
  let calls = 0;
  const run = createBudgetWorkflow({
    fetch: api,
    prepare: async () => {},
    model: async () => {
      calls++;
    },
  });
  const result = await run({
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
    allowedAppIds: [55],
    actionsUrl: "",
  });
  expect(result.status).toBe(status);
  expect(calls).toBe(status === "completed" ? 1 : 0);
});

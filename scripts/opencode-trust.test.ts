import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { authorizeComment } from "./opencode-trust";
import { runCommand } from "./test-command";

const repository = "calendar-owner/calendar";
const owner = "calendar-owner";
const token = "secret-test-token";

function issueEvent(author = "writer") {
  return {
    action: "created",
    repository: { full_name: repository, owner: { login: owner } },
    issue: { number: 9 },
    comment: { body: "/oc fix this", user: { login: author }, author_association: "NONE" },
    sender: { login: owner },
  };
}

test("checks the original comment author's repository permission before allowing a command", async () => {
  const requests: { url: string; options?: RequestInit }[] = [];
  const decision = await authorizeComment({
    eventName: "issue_comment",
    event: issueEvent(),
    repository,
    owner,
    token,
    fetch: async (url, options) => {
      requests.push({ url: String(url), options });
      return Response.json({ permission: "write" });
    },
  });

  expect(decision).toEqual({ allowed: true, number: 9, reason: "authorized" });
  expect(requests).toHaveLength(1);
  expect(requests[0].url).toBe(
    "https://api.github.com/repos/calendar-owner/calendar/collaborators/writer/permission",
  );
  expect(requests[0].options?.headers).toMatchObject({ Authorization: `Bearer ${token}` });
  expect(requests[0].options?.method).toBe("GET");
  expect(requests[0].options?.headers).toMatchObject({
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  });
  expect(requests[0].options?.signal).toBeInstanceOf(AbortSignal);
});

test.each([
  ["admin", true],
  ["maintain", true],
  ["read", false],
  ["triage", false],
  ["none", false],
  ["unknown", false],
  [undefined, false],
])(
  "requires write-equivalent API permission, not COLLABORATOR association: %s",
  async (permission, allowed) => {
    const event = issueEvent();
    event.comment.author_association = "COLLABORATOR";
    expect(
      await authorizeComment({
        eventName: "issue_comment",
        event,
        repository,
        owner,
        token,
        fetch: async () => Response.json({ permission }),
      }),
    ).toEqual({ allowed, number: 9, reason: allowed ? "authorized" : "insufficient-permission" });
  },
);

test.each([
  ["missing event", null],
  ["unrecognized action", { ...issueEvent(), action: "edited" }],
  ["missing action", { ...issueEvent(), action: undefined }],
  ["different repository", { ...issueEvent(), repository: { full_name: "attacker/calendar" } }],
  [
    "different repository owner",
    { ...issueEvent(), repository: { full_name: repository, owner: { login: "attacker" } } },
  ],
  ["missing comment", { ...issueEvent(), comment: null }],
  ["missing original author", { ...issueEvent(), comment: { body: "/oc fix" } }],
  ["malicious original author", issueEvent("writer/../../admin?token=steal")],
  ["string number", { ...issueEvent(), issue: { number: "9" } }],
  ["negative number", { ...issueEvent(), issue: { number: -9 } }],
  ["fractional number", { ...issueEvent(), issue: { number: 9.5 } }],
  ["unsafe number", { ...issueEvent(), issue: { number: Number.MAX_SAFE_INTEGER + 1 } }],
])("rejects invalid event data before any GitHub request: %s", async (_name, event) => {
  let requested = false;
  expect(
    await authorizeComment({
      eventName: "issue_comment",
      event,
      repository,
      owner,
      token,
      fetch: async () => {
        requested = true;
        return Response.json({ permission: "write" });
      },
    }),
  ).toEqual({ allowed: false, reason: "invalid-event" });
  expect(requested).toBe(false);
});

test("accepts GitHub's maintain role mapped to write, without trusting role_name alone", async () => {
  expect(
    await authorizeComment({
      eventName: "issue_comment",
      event: issueEvent(),
      repository,
      owner,
      token,
      fetch: async () => Response.json({ permission: "write", role_name: "maintain" }),
    }),
  ).toEqual({ allowed: true, number: 9, reason: "authorized" });
});

test.each([
  { eventName: "pull_request" },
  { repository: "calendar-owner/calendar/../../secrets" },
  { repository: "calendar-owner/calendar\nallowed=true" },
  { owner: "attacker" },
  { token: "" },
])("rejects invalid workflow inputs before any GitHub request: %j", async (overrides) => {
  let requested = false;
  expect(
    await authorizeComment({
      eventName: "issue_comment",
      event: issueEvent(),
      repository,
      owner,
      token,
      ...overrides,
      fetch: async () => {
        requested = true;
        return Response.json({ permission: "write" });
      },
    }),
  ).toEqual({ allowed: false, reason: "invalid-input" });
  expect(requested).toBe(false);
});

test.each([
  ["/oc", true],
  ["/opencode fix this", true],
  ["please /oc fix this", true],
  ["please\n/opencode\tfix this", true],
  ["/occupy fix this", false],
  ["/opencode-malicious fix this", false],
  ["https://example.com/oc", false],
  ["not/oc fix this", false],
  ["/OC fix this", false],
  ["/oc; echo secret", false],
  ["", false],
  [null, false],
])(
  "requires a complete command token while preserving ordinary command text: %j",
  async (body, allowed) => {
    let requested = false;
    const event = issueEvent();
    expect(
      await authorizeComment({
        eventName: "issue_comment",
        event: { ...event, comment: { ...event.comment, body } },
        repository,
        owner,
        token,
        fetch: async () => {
          requested = true;
          return Response.json({ permission: "write" });
        },
      }),
    ).toEqual({ allowed, number: 9, reason: allowed ? "authorized" : "not-command" });
    expect(requested).toBe(allowed);
  },
);

test("allows the original owner without a collaborator request, case-insensitively", async () => {
  const decision = await authorizeComment({
    eventName: "issue_comment",
    event: issueEvent("Calendar-Owner"),
    repository,
    owner,
    token,
    fetch: async () => {
      throw new Error("owner must not require collaborator membership");
    },
  });
  expect(decision).toEqual({ allowed: true, number: 9, reason: "authorized" });
});

test("does not authorize an outsider based on the rerun actor or OWNER association", async () => {
  const event = issueEvent("outsider");
  event.comment.author_association = "OWNER";
  const requests: string[] = [];
  const decision = await authorizeComment({
    eventName: "issue_comment",
    event: { ...event, actor: owner, triggering_actor: owner },
    repository,
    owner,
    token,
    fetch: async (url) => {
      requests.push(String(url));
      return Response.json({ permission: "read" });
    },
  });
  expect(decision).toEqual({ allowed: false, number: 9, reason: "insufficient-permission" });
  expect(requests).toEqual([
    "https://api.github.com/repos/calendar-owner/calendar/collaborators/outsider/permission",
  ]);
});

test.each([302, 401, 403, 404, 429, 500])(
  "fails closed on HTTP %s even with a misleading permission body",
  async (status) => {
    let redirect: RequestRedirect | undefined;
    const decision = await authorizeComment({
      eventName: "issue_comment",
      event: issueEvent(),
      repository,
      owner,
      token,
      fetch: async (_url, options) => {
        redirect = options?.redirect;
        return Response.json({ permission: "write", message: token }, { status });
      },
    });
    expect(decision).toEqual({ allowed: false, number: 9, reason: "github-error" });
    expect(redirect).toBe("error");
    expect(JSON.stringify(decision)).not.toContain(token);
  },
);

test.each(["network", "json"])("sanitizes %s failures without authorizing", async (failure) => {
  const decision = await authorizeComment({
    eventName: "issue_comment",
    event: issueEvent(),
    repository,
    owner,
    token,
    fetch: async () => {
      if (failure === "network") throw new Error(`request failed: ${token}`);
      return new Response(`not JSON: ${token}`);
    },
  });
  expect(decision).toEqual({ allowed: false, number: 9, reason: "github-error" });
  expect(JSON.stringify(decision)).not.toContain(token);
});

test.each(
  [null, [], { role_name: "admin" }, { permission: { admin: true } }].map((response) => ({
    response,
  })),
)("does not infer authority from missing or malformed permission: %j", async ({ response }) => {
  expect(
    await authorizeComment({
      eventName: "issue_comment",
      event: issueEvent(),
      repository,
      owner,
      token,
      fetch: async () => Response.json(response),
    }),
  ).toEqual({ allowed: false, number: 9, reason: "insufficient-permission" });
});

function prEvent(eventName: string, author = owner) {
  const event = issueEvent(author);
  if (eventName === "issue_comment") {
    return {
      ...event,
      issue: { number: 9, pull_request: { url: "https://attacker.invalid/not-authoritative" } },
    };
  }
  return {
    action: event.action,
    repository: event.repository,
    comment: event.comment,
    pull_request: { number: 9, head: { repo: { full_name: repository } } },
  };
}

function internalPr() {
  return {
    number: 9,
    base: { repo: { id: 123, full_name: repository } },
    head: { repo: { id: 123, full_name: repository } },
  };
}

test.each([
  ["issue_comment", owner],
  ["pull_request_review_comment", owner],
  ["issue_comment", "writer"],
  ["pull_request_review_comment", "writer"],
])("fetches authoritative PR metadata for %s by %s", async (eventName, author) => {
  const requests: string[] = [];
  const decision = await authorizeComment({
    eventName,
    event: prEvent(eventName, author),
    repository,
    owner,
    token,
    fetch: async (url) => {
      requests.push(String(url));
      return Response.json(
        String(url).endsWith("/pulls/9") ? internalPr() : { permission: "write" },
      );
    },
  });
  expect(decision).toEqual({ allowed: true, number: 9, reason: "authorized" });
  expect(requests).toContain("https://api.github.com/repos/calendar-owner/calendar/pulls/9");
  expect(requests).toHaveLength(author === owner ? 1 : 2);
  expect(requests.some((url) => url.includes("attacker.invalid"))).toBe(false);
});

test.each([null, false, [], "not-a-pr"].map((pull_request) => ({ pull_request })))(
  "rejects malformed issue-comment PR markers without an API request: %j",
  async ({ pull_request }) => {
    let requested = false;
    expect(
      await authorizeComment({
        eventName: "issue_comment",
        event: { ...issueEvent(owner), issue: { number: 9, pull_request } },
        repository,
        owner,
        token,
        fetch: async () => {
          requested = true;
          return Response.json(internalPr());
        },
      }),
    ).toEqual({ allowed: false, reason: "invalid-event" });
    expect(requested).toBe(false);
  },
);

for (const eventName of ["issue_comment", "pull_request_review_comment"]) {
  test.each([
    ["fork", { ...internalPr(), head: { repo: { id: 456, full_name: "attacker/calendar" } } }],
    ["null head repository", { ...internalPr(), head: { repo: null } }],
    ["missing head repository", { ...internalPr(), head: {} }],
    ["unknown head repository", { ...internalPr(), head: { repo: { id: 123 } } }],
    [
      "foreign base",
      { ...internalPr(), base: { repo: { id: 123, full_name: "attacker/calendar" } } },
    ],
    [
      "different repository ID",
      { ...internalPr(), head: { repo: { id: 456, full_name: repository } } },
    ],
    ["missing repository ID", { ...internalPr(), head: { repo: { full_name: repository } } }],
    ["different PR number", { ...internalPr(), number: 10 }],
    ["unknown payload", null],
  ])(
    `${eventName}: refuses %s even when the original author is the owner`,
    async (_name, metadata) => {
      const requests: string[] = [];
      expect(
        await authorizeComment({
          eventName,
          event: prEvent(eventName),
          repository,
          owner,
          token,
          fetch: async (url) => {
            requests.push(String(url));
            return Response.json(metadata);
          },
        }),
      ).toEqual({ allowed: false, number: 9, reason: "unsafe-pull-request" });
      expect(requests).toEqual(["https://api.github.com/repos/calendar-owner/calendar/pulls/9"]);
    },
  );

  test(`${eventName}: a failed PR lookup cannot authorize an owner`, async () => {
    expect(
      await authorizeComment({
        eventName,
        event: prEvent(eventName),
        repository,
        owner,
        token,
        fetch: async () => Response.json({ message: token }, { status: 403 }),
      }),
    ).toEqual({ allowed: false, number: 9, reason: "github-error" });
  });
}

test.each([
  ["write", "allowed=true\nnumber=9\nreason=authorized\n"],
  ["read", "allowed=false\nnumber=9\nreason=insufficient-permission\n"],
])(
  "CLI writes a workflow decision for original-author permission %s",
  async (permission, expected) => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-trust-"));
    try {
      const eventPath = join(directory, "event.json");
      const outputPath = join(directory, "output");
      await writeFile(eventPath, JSON.stringify(issueEvent()));
      const fixture = `globalThis.fetch = async (url, options) => {
      if (url !== "https://api.github.com/repos/calendar-owner/calendar/collaborators/writer/permission" ||
          options.headers.Authorization !== "Bearer secret-test-token") throw new Error("unexpected request");
      return Response.json({ permission: ${JSON.stringify(permission)} });
    };`;
      const stdout = await runCommand(
        process.execPath,
        [
          "--import",
          `data:text/javascript,${encodeURIComponent(fixture)}`,
          "scripts/opencode-trust.ts",
        ],
        {
          env: {
            ...process.env,
            GITHUB_EVENT_PATH: eventPath,
            GITHUB_OUTPUT: outputPath,
            GITHUB_EVENT_NAME: "issue_comment",
            GITHUB_REPOSITORY: repository,
            GITHUB_REPOSITORY_OWNER: owner,
            GH_TOKEN: token,
            GITHUB_TOKEN: "not-the-workflow-token",
            GITHUB_ACTOR: owner,
            GITHUB_TRIGGERING_ACTOR: owner,
          },
        },
      );
      expect(await readFile(outputPath, "utf8")).toBe(expected);
      expect(stdout).not.toContain(token);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("CLI rejects invalid event JSON with a nonzero exit and sanitized outputs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-trust-"));
  try {
    const eventPath = join(directory, "event.json");
    const outputPath = join(directory, "output");
    await writeFile(eventPath, `invalid JSON containing ${token}`);
    await expect(
      runCommand(process.execPath, ["scripts/opencode-trust.ts"], {
        env: {
          ...process.env,
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_OUTPUT: outputPath,
          GITHUB_EVENT_NAME: "issue_comment",
          GITHUB_REPOSITORY: repository,
          GITHUB_REPOSITORY_OWNER: owner,
          GITHUB_TOKEN: token,
        },
      }),
    ).rejects.toThrow(/exit code 1[\s\S]*OpenCode trust: invalid-event-file/);
    expect(await readFile(outputPath, "utf8")).toBe(
      "allowed=false\nnumber=\nreason=invalid-event-file\n",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const eventName of ["issue_comment", "pull_request_review_comment"]) {
  test.each([true, false])(
    `${eventName}: CLI enforces the PR repository gate (internal=%s)`,
    async (internal) => {
      const directory = await mkdtemp(join(tmpdir(), "opencode-trust-"));
      try {
        const eventPath = join(directory, "event.json");
        const outputPath = join(directory, "output");
        await writeFile(eventPath, JSON.stringify(prEvent(eventName)));
        const metadata = internal ? internalPr() : { ...internalPr(), head: { repo: null } };
        const fixture = `globalThis.fetch = async (url) => {
        if (url !== "https://api.github.com/repos/calendar-owner/calendar/pulls/9") throw new Error("unexpected request");
        return Response.json(${JSON.stringify(metadata)});
      };`;
        await runCommand(
          process.execPath,
          [
            "--import",
            `data:text/javascript,${encodeURIComponent(fixture)}`,
            "scripts/opencode-trust.ts",
          ],
          {
            env: {
              ...process.env,
              GITHUB_EVENT_PATH: eventPath,
              GITHUB_OUTPUT: outputPath,
              GITHUB_EVENT_NAME: eventName,
              GITHUB_REPOSITORY: repository,
              GITHUB_REPOSITORY_OWNER: owner,
              GITHUB_TOKEN: token,
            },
          },
        );
        expect(await readFile(outputPath, "utf8")).toBe(
          internal
            ? "allowed=true\nnumber=9\nreason=authorized\n"
            : "allowed=false\nnumber=9\nreason=unsafe-pull-request\n",
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}

test("CLI fails with sanitized diagnostics when workflow outputs cannot be written", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-trust-"));
  try {
    const eventPath = join(directory, "event.json");
    await writeFile(eventPath, JSON.stringify(issueEvent(owner)));
    const error = await runCommand(process.execPath, ["scripts/opencode-trust.ts"], {
      env: {
        ...process.env,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_OUTPUT: join(directory, token, "missing"),
        GITHUB_EVENT_NAME: "issue_comment",
        GITHUB_REPOSITORY: repository,
        GITHUB_REPOSITORY_OWNER: owner,
        GITHUB_TOKEN: token,
      },
    }).then(
      () => "unexpected success",
      (error: unknown) => String(error),
    );
    expect(error).toContain("exit code 1");
    expect(error).toContain("OpenCode trust: unable to write decision");
    expect(error).not.toContain(token);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bounds a GitHub response that sends headers but stalls its JSON body", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.write('{"permission":');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing fixture server port");
    const start = performance.now();
    const decision = await authorizeComment({
      eventName: "issue_comment",
      event: issueEvent(),
      repository,
      owner,
      token,
      fetch: (url, options) =>
        fetch(`http://127.0.0.1:${address.port}${new URL(String(url)).pathname}`, options),
    });
    expect(decision).toEqual({ allowed: false, number: 9, reason: "github-error" });
    expect(performance.now() - start).toBeLessThan(12000);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}, 15000);

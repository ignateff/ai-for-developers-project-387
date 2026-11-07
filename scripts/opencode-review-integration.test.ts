import { copyFile, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { createProductionWorkflow } from "./opencode-production-workflow.ts";
import { reviewWorkflow } from "./opencode-review-workflow.ts";
import { publishWorkflow } from "./opencode-review-publish-cli.ts";
import { createBudgetWorkflow } from "./opencode-budget-workflow.ts";
import { ReviewFailure } from "./opencode-review-failure.ts";
import { publishReview } from "./opencode-review-publish.ts";
import { runBudgetCli } from "./opencode-budget-cli.ts";
import { parse } from "yaml";
import { createReviewAdapter } from "./opencode-review.ts";

test.each([
  "baseline",
  "oversized collector warning",
  "malicious model priority",
  "malicious missing requirements",
  "crowded essential context",
  "no room for essential evidence",
  "oversized findings",
  "exact limitation capacity",
  "unavailable linked source",
  "too many findings",
  "oversized finding field",
])("review publication handles %s", async (scenario) => {
  const dir = await mkdtemp(join(tmpdir(), "review-limitations-"));
  const sha = "a".repeat(40);
  const base = "b".repeat(40);
  const repository = "ignateff/ai-for-developers-project-387";
  const comments: string[] = [];
  const pr = {
    number: 7,
    state: "open",
    draft: false,
    changed_files: 1,
    body:
      (scenario === "malicious missing requirements"
        ? "No linked issue"
        : "https://github.com/ignateff/ai-for-developers-project-386/issues/12\nhttps://example.com/evidence") +
      (scenario === "oversized collector warning" ? `\n[long](${"x".repeat(13000)}.md)` : "") +
      (scenario === "crowded essential context"
        ? Array.from({ length: 12 }, (_, i) => `\n[long](${"x".repeat(1100)}${i}.md)`).join("")
        : "") +
      (scenario === "unavailable linked source"
        ? "\nhttps://github.com/ignateff/ai-for-developers-project-386/issues/13"
        : ""),
    user: { type: "User", login: "ignateff" },
    base: { sha: base, repo: { id: 1, full_name: repository } },
    head: { sha, repo: { id: 1, full_name: repository } },
  };
  const api: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/pulls/7")) return Response.json(pr);
    if (path.endsWith("/pulls/7/files"))
      return Response.json([{ filename: "booking.ts", status: "added" }]);
    if (
      path.includes("/contents/") &&
      scenario === "crowded essential context" &&
      path.includes("xxxx")
    )
      return new Response(null, { status: 404 });
    if (path.includes("/contents/"))
      return Response.json({
        type: "file",
        encoding: "base64",
        content: Buffer.from("source").toString("base64"),
        size: 6,
      });
    if (path.endsWith("/issues/12"))
      return Response.json({
        title: "Requirements",
        body: Array.from({ length: 100 }, (_, i) => `[link](doc${i}.md)`).join("\n"),
      });
    if (path.endsWith("/issues/13")) return new Response(null, { status: 404 });
    if (path.endsWith("/issues/7/comments") && init?.method === "POST") {
      comments.push(JSON.parse(String(init.body)).body);
      return Response.json({});
    }
    if (path.endsWith("/issues/7/comments")) return Response.json([]);
    if (path.endsWith("/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
    if (path.endsWith("/status"))
      return scenario === "malicious model priority" || scenario === "crowded essential context"
        ? Response.json({})
        : Response.json({ state: "success", statuses: [] });
    return Response.json([]);
  };
  const env = {
    RUNNER_TEMP: dir,
    GITHUB_RUN_ID: "1",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_REPOSITORY: repository,
    GH_TOKEN: "fixture-token",
    DEEPSEEK_API_KEY: "fixture-key",
    OPENCODE_PR_NUMBER: "7",
    OPENCODE_HEAD_SHA: sha,
    OPENCODE_REVIEW_ARTIFACT: "review-1-1",
  };
  try {
    await mkdir(join(dir, "opencode-review-1-1"));
    await writeFile(join(dir, "opencode-review-1-1", "binary"), "/fixture");
    const review = createReviewAdapter({
      verify: async () => {},
      run: async (_binary, args, options) => {
        if (args[0] === "debug") {
          const config = JSON.parse(options.env.OPENCODE_CONFIG_CONTENT!);
          return JSON.stringify({
            name: "reviewer",
            permission: Object.entries(config.permission).map(([permission, action]) => ({
              permission,
              action,
              pattern: "*",
            })),
          });
        }
        const files = (await readdir(options.cwd))
          .filter((name) => name.startsWith("snapshot-"))
          .sort();
        const contents = await Promise.all(
          files.map((name) => readFile(join(options.cwd, name), "utf8")),
        );
        const snapshot = JSON.parse(
          contents
            .flatMap((content) => content.split("\n").map((line) => JSON.parse(line)))
            .join(""),
        );
        if (scenario !== "malicious missing requirements")
          expect(JSON.stringify(snapshot.agreement).match(/relative document link/g)).toHaveLength(
            1,
          );
        const reads = files.map((name, i) =>
          JSON.stringify({
            type: "tool_use",
            part: {
              tool: "read",
              state: {
                status: "completed",
                input: { filePath: name },
                output: `<content>\n${contents[i]
                  .split("\n")
                  .map((line, n) => `${n + 1}: ${line}`)
                  .join("\n")}\n</content>`,
              },
            },
          }),
        );
        const report = {
          summary: "Review completed",
          findings:
            scenario === "too many findings"
              ? Array.from({ length: 101 }, (_, i) => ({
                  file: "booking.ts",
                  line: i + 1,
                  conditions: "When booking",
                  consequence: "Confirmed defect",
                }))
              : scenario === "oversized finding field"
                ? [
                    {
                      file: "booking.ts",
                      line: 1,
                      conditions: "x".repeat(12001),
                      consequence: "Confirmed defect",
                    },
                  ]
                : scenario === "oversized findings" ||
                    scenario === "crowded essential context" ||
                    scenario === "no room for essential evidence"
                  ? Array.from({ length: scenario === "oversized findings" ? 6 : 5 }, (_, i) => ({
                      file: "booking.ts",
                      line: i + 1,
                      conditions: "x".repeat(
                        scenario === "crowded essential context"
                          ? 11600
                          : scenario === "no room for essential evidence"
                            ? 11900
                            : 11000,
                      ),
                      consequence: "Confirmed defect",
                    }))
                  : [
                      {
                        file: "booking.ts",
                        line: 1,
                        conditions: "When booking",
                        consequence: "Confirmed defect",
                      },
                    ],
          limitations: [
            ...Array.from(
              {
                length:
                  scenario === "exact limitation capacity"
                    ? 100 - snapshot.agreement.limitations.length
                    : 99,
              },
              (_, i) =>
                `${scenario.startsWith("malicious") ? "Requirements unavailable:" : "Model limitation"} ${i}: ${"x".repeat(scenario.startsWith("malicious") || scenario === "exact limitation capacity" ? 5 : 650)}`,
            ),
          ],
        };
        return [
          ...reads,
          JSON.stringify({ type: "text", part: { text: JSON.stringify(report) } }),
          JSON.stringify({ type: "step_finish", part: { reason: "stop" } }),
        ].join("\n");
      },
    });
    await reviewWorkflow("run", env, { fetch: api, review });
    const savedReport = JSON.parse(
      await readFile(join(dir, "opencode-review-1-1", "review.json"), "utf8"),
    );
    if (scenario === "oversized collector warning") {
      expect(savedReport.limitations).toContainEqual(expect.stringContaining("x".repeat(13000)));
      expect(savedReport.limitations).toContainEqual(
        expect.stringContaining("Model limitation 98:"),
      );
    }
    if (scenario === "baseline")
      expect(savedReport.limitations).toContainEqual(
        expect.stringContaining("Model limitation 98:"),
      );
    if (scenario === "too many findings") expect(savedReport.findings).toHaveLength(101);
    if (scenario === "oversized finding field")
      expect(savedReport.findings[0].conditions).toHaveLength(12001);
    if (scenario === "oversized findings" || scenario === "no room for essential evidence") {
      const saved = JSON.parse(
        await readFile(join(dir, "opencode-review-1-1", "review.json"), "utf8"),
      );
      expect(saved.findings).toHaveLength(scenario === "oversized findings" ? 6 : 5);
      expect(saved.findings[0].conditions).toHaveLength(
        scenario === "oversized findings" ? 11000 : 11900,
      );
      expect(saved.limitations).toContainEqual(expect.stringContaining("Model limitation 98:"));
    }
    await publishWorkflow({
      env,
      fetch: api,
      authorId: 42,
      readReport: async () =>
        JSON.parse(await readFile(join(dir, "opencode-review-1-1", "review.json"), "utf8")),
    });
    expect(comments).toHaveLength(1);
    if (scenario === "exact limitation capacity") {
      expect(comments[0]).not.toMatch(/limitations.*(?:omitted|truncated)/i);
      expect(comments[0].match(/- Limitation:/g)).toHaveLength(100);
      return;
    }
    if (
      scenario === "oversized findings" ||
      scenario === "no room for essential evidence" ||
      scenario === "oversized collector warning" ||
      scenario === "crowded essential context" ||
      scenario === "too many findings" ||
      scenario === "oversized finding field"
    ) {
      if (scenario === "crowded essential context")
        expect(
          savedReport.limitations.filter((s: string) =>
            s.includes("was unavailable at its pinned ref"),
          ),
        ).toHaveLength(12);
      expect(comments[0]).toMatch(/findings.*(?:not included|not displayed)/i);
      expect(comments[0]).toContain("review-1-1");
      expect(comments[0]).toMatch(/artifact/i);
      expect(comments[0]).toMatch(/human/i);
      return;
    }
    if (scenario === "malicious missing requirements")
      expect(comments[0]).toContain(
        "Requirements unavailable: No linked requirements could be loaded.",
      );
    else expect(comments[0]).toContain("relative document link");
    if (scenario === "unavailable linked source")
      expect(comments[0]).toContain(
        "Linked issue ignateff/ai-for-developers-project-386#13 was unavailable.",
      );
    expect(comments[0]).toContain("Only changed files");
    if (scenario === "malicious model priority" || scenario === "crowded essential context") {
      expect(comments[0]).toContain("Agreement is unconfirmed");
      expect(comments[0]).toContain("External or unsupported links were not loaded");
      expect(comments[0]).toContain("CI context is incomplete");
    }
    if (scenario === "crowded essential context") expect(comments[0]).toContain("Confirmed defect");
    else expect(comments[0]).toContain("booking.ts:1 — When booking; Confirmed defect");
    expect(comments[0]).toMatch(/limitations.*(?:omitted|truncated)/i);
    expect(comments[0].length).toBeLessThanOrEqual(60000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test.each([false, true])(
  "missing requirements with long base documents can be published (release: %s)",
  async (isRelease) => {
    const dir = await mkdtemp(join(tmpdir(), "review-missing-requirements-"));
    const sha = "a".repeat(40);
    const base = "b".repeat(40);
    const repository = "ignateff/ai-for-developers-project-387";
    const document = "Trusted base document evidence ".repeat(600);
    const comments: { id: number; user: { id: number }; body: string }[] = [];
    const pr = {
      number: 7,
      state: "open",
      draft: false,
      changed_files: 1,
      body: "No linked issue",
      user: isRelease
        ? { type: "Bot", login: "calendar-release-ignateff-bot[bot]", id: 351107404 }
        : { type: "User", login: "ignateff" },
      base: { sha: base, repo: { id: 1, full_name: repository } },
      head: { sha, repo: { id: 1, full_name: repository } },
    };
    const api: typeof fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/pulls/7")) return Response.json(pr);
      if (path.endsWith("/pulls/7/files"))
        return Response.json([{ filename: "booking.ts", status: "added" }]);
      if (path.includes("/contents/")) {
        const content = path.endsWith("/booking.ts") ? "source" : document;
        return Response.json({
          type: "file",
          encoding: "base64",
          content: Buffer.from(content).toString("base64"),
          size: Buffer.byteLength(content),
        });
      }
      if (path.endsWith("/issues/7/comments") && init?.method === "POST") {
        const comment = {
          id: comments.length + 1,
          user: { id: 42 },
          body: JSON.parse(String(init.body)).body,
        };
        comments.push(comment);
        return Response.json(comment, { status: 201 });
      }
      if (path.endsWith("/issues/7/comments")) return Response.json(comments);
      if (path.endsWith("/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (path.endsWith("/status")) return Response.json({ state: "success", statuses: [] });
      return Response.json([]);
    };
    const env = {
      RUNNER_TEMP: dir,
      GITHUB_RUN_ID: "1",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_REPOSITORY: repository,
      GH_TOKEN: "fixture-token",
      DEEPSEEK_API_KEY: "fixture-key",
      OPENCODE_PR_NUMBER: "7",
      OPENCODE_HEAD_SHA: sha,
      OPENCODE_REVIEW_ARTIFACT: "review-1-1",
    };
    try {
      const review = createReviewAdapter({
        verify: async () => {},
        run: async (_binary, args, options) => {
          if (args[0] === "debug") {
            const config = JSON.parse(options.env.OPENCODE_CONFIG_CONTENT!);
            return JSON.stringify({
              name: "reviewer",
              permission: Object.entries(config.permission).map(([permission, action]) => ({
                permission,
                action,
                pattern: "*",
              })),
            });
          }
          const files = (await readdir(options.cwd))
            .filter((name) => name.startsWith("snapshot-"))
            .sort();
          const contents = await Promise.all(
            files.map((name) => readFile(join(options.cwd, name), "utf8")),
          );
          const snapshot = JSON.parse(
            contents
              .flatMap((content) => content.split("\n").map((line) => JSON.parse(line)))
              .join(""),
          );
          expect(snapshot.isRelease).toBe(isRelease);
          expect(snapshot.requirements).toMatchObject({
            availability: "unavailable",
            reason: "No linked requirements could be loaded.",
          });
          expect(snapshot.requirements.description).toBe("No linked issue");
          expect(snapshot.requirements.baseDocs).toContainEqual({
            path: "AGENTS.md",
            sha: base,
            body: document,
          });
          expect(snapshot.requirements.reason).not.toContain(document);
          const reads = files.map((name, i) =>
            JSON.stringify({
              type: "tool_use",
              part: {
                tool: "read",
                state: {
                  status: "completed",
                  input: { filePath: name },
                  output: `<content>\n${contents[i]
                    .split("\n")
                    .map((line, n) => `${n + 1}: ${line}`)
                    .join("\n")}\n</content>`,
                },
              },
            }),
          );
          return [
            ...reads,
            JSON.stringify({
              type: "text",
              part: {
                text: JSON.stringify({
                  summary: "No confirmed defects",
                  limitations: [],
                  findings: [],
                }),
              },
            }),
            JSON.stringify({ type: "step_finish", part: { reason: "stop" } }),
          ].join("\n");
        },
      });
      const run = createProductionWorkflow({
        fetch: api,
        prepare: async () => {
          await mkdir(join(dir, "opencode-review-1-1"));
          await writeFile(join(dir, "opencode-review-1-1", "binary"), "/fixture");
        },
        model: async () => {
          await reviewWorkflow("run", env, { fetch: api, review });
        },
      });
      const result = await run({
        kind: "review",
        eventName: "pull_request",
        event: {
          action: "opened",
          repository: { full_name: repository },
          pull_request: { number: 7 },
        },
        repository,
        owner: "ignateff",
        token: "fixture-token",
        authorId: 42,
        allowedAppIds: [351107404],
        actionsUrl: `https://github.com/${repository}/actions/runs/1`,
      });
      expect(result.status).toBe("completed");
      const reportPath = join(dir, "opencode-review-1-1", "review.json");
      await publishWorkflow({
        env,
        fetch: api,
        authorId: 42,
        readReport: async () => JSON.parse(await readFile(reportPath, "utf8")),
      });
      const report = comments.find((comment) => comment.body.includes("opencode-review-report"));
      expect(report?.body).toContain(
        "Requirements unavailable: No linked requirements could be loaded.",
      );
      expect(report?.body).not.toContain(document);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("a review that runs out of preparation time reports infrastructure failure without starting the model", async () => {
  vi.useFakeTimers();
  const dir = await mkdtemp(join(tmpdir(), "review-deadline-"));
  const now = Date.now();
  const sha = "a".repeat(40);
  const eventPath = join(dir, "event.json");
  const env = {
    RUNNER_TEMP: dir,
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_OUTPUT: join(dir, "output"),
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_REPOSITORY: "owner/repo",
    GITHUB_REPOSITORY_OWNER: "owner",
    GITHUB_RUN_ID: "1",
    GITHUB_RUN_ATTEMPT: "1",
    GH_TOKEN: "token",
    DEEPSEEK_API_KEY: "key",
    OPENCODE_REVIEW_STARTED_AT: String(now),
  };
  let calls = 0;
  const comments: any[] = [];
  const api: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/pulls/7"))
      return Response.json({
        number: 7,
        state: "open",
        draft: false,
        user: { type: "User", login: "owner" },
        base: { repo: { id: 1, full_name: "owner/repo" } },
        head: { sha, repo: { id: 1, full_name: "owner/repo" } },
      });
    if (init?.method === "POST") {
      const comment = { id: 1, user: { id: 42 }, body: JSON.parse(String(init.body)).body };
      comments.push(comment);
      return Response.json(comment);
    }
    if (init?.method === "PATCH") {
      comments[0].body = JSON.parse(String(init.body)).body;
      return Response.json(comments[0]);
    }
    return Response.json(comments);
  };
  try {
    await writeFile(
      eventPath,
      JSON.stringify({
        action: "opened",
        repository: { full_name: "owner/repo" },
        pull_request: { number: 7 },
      }),
    );
    const result = await runBudgetCli({
      kind: "review",
      env,
      fetch: api,
      authorId: 42,
      prepare: async () => {
        vi.advanceTimersByTime(8 * 60_000);
      },
      model: async () => {
        calls++;
      },
    });
    expect(result.status).toBe("infra");
    expect(calls).toBe(0);
    expect(
      JSON.parse(await readFile(join(dir, "opencode-review-1-1", "review.json"), "utf8")),
    ).toEqual({ failure: "infra" });
  } finally {
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  }
});

test("production CLI emits a failure artifact and workflow outputs for independent publication", async () => {
  const dir = await mkdtemp(join(tmpdir(), "review-cli-"));
  const sha = "a".repeat(40);
  const comments: { id: number; user: { id: number }; body: string }[] = [];
  const repository = "owner/repo";
  const api: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/pulls/7"))
      return Response.json({
        number: 7,
        state: "open",
        draft: false,
        user: { type: "User", login: "owner" },
        base: { repo: { id: 1, full_name: repository } },
        head: { sha, repo: { id: 1, full_name: repository } },
      });
    if (init?.method === "POST") {
      const comment = {
        id: comments.length + 1,
        user: { id: 42 },
        body: JSON.parse(String(init.body)).body,
      };
      comments.push(comment);
      return Response.json(comment);
    }
    const comment = comments.find((item) => path.endsWith(`/issues/comments/${item.id}`));
    if (comment && init?.method === "PATCH") {
      comment.body = JSON.parse(String(init.body)).body;
      return Response.json(comment);
    }
    if (comment && init?.method === "DELETE") {
      comments.splice(comments.indexOf(comment), 1);
      return new Response(null, { status: 204 });
    }
    return Response.json(comments);
  };
  const eventPath = join(dir, "event.json");
  const output = join(dir, "output");
  const env = {
    RUNNER_TEMP: dir,
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_OUTPUT: output,
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_REPOSITORY: repository,
    GITHUB_REPOSITORY_OWNER: "owner",
    GITHUB_RUN_ID: "1",
    GITHUB_RUN_ATTEMPT: "1",
    GH_TOKEN: "token",
    DEEPSEEK_API_KEY: "key",
  };
  try {
    await writeFile(
      eventPath,
      JSON.stringify({
        action: "opened",
        repository: { full_name: repository },
        pull_request: { number: 7 },
      }),
    );
    const result = await runBudgetCli({
      kind: "review",
      env,
      fetch: api,
      authorId: 42,
      prepare: async () => {},
      model: async () => {
        throw new ReviewFailure("timeout");
      },
    });
    expect(result.status).toBe("timeout");
    const outputs = Object.fromEntries(
      (await readFile(output, "utf8"))
        .trim()
        .split("\n")
        .map((line) => line.split("=")),
    );
    expect(outputs).toMatchObject({ report: "true", number: "7", sha });
    const workflow = parse(await readFile(".github/workflows/opencode-review.yml", "utf8"));
    const steps = workflow.jobs.review.steps;
    expect(steps.find((step: { id?: string }) => step.id === "report").if).toContain(
      "steps.workflow.outputs.report == 'true'",
    );
    expect(
      steps.find((step: { name?: string }) => step.name === "Save review result for publication")
        .if,
    ).toContain("steps.workflow.outputs.report == 'true'");
    expect(workflow.jobs.publish.if).toContain("needs.review.outputs.artifact != ''");
    const artifact = join(dir, "opencode-review-1-1", "review.json");
    expect(JSON.parse(await readFile(artifact, "utf8"))).toEqual({ failure: "timeout" });
    await mkdir(join(dir, "opencode-review-publication"));
    await copyFile(artifact, join(dir, "opencode-review-publication", "review.json"));
    await publishWorkflow({
      env: {
        ...env,
        OPENCODE_PR_NUMBER: outputs.number,
        OPENCODE_HEAD_SHA: outputs.sha,
        OPENCODE_REVIEW_ARTIFACT: "review-1-1",
      },
      fetch: api,
      authorId: 42,
      readReport: async (path) => JSON.parse(await readFile(path, "utf8")),
    });
    expect(comments.find((item) => item.body.includes("opencode-review-report"))?.body).toContain(
      "Review stopped: timeout",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test.each(["infra", "timeout", "agent_failed"] as const)(
  "an admitted %s is independently published with SHA and logs, never as a successful review",
  async (reason) => {
    const sha = "a".repeat(40);
    const repository = "owner/repo";
    const comments: { id: number; user: { id: number }; body: string }[] = [];
    let head = sha;
    const api: typeof fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/pulls/7"))
        return Response.json({
          number: 7,
          state: "open",
          draft: false,
          user: { type: "User", login: "owner" },
          base: { repo: { id: 1, full_name: repository } },
          head: { sha: head, repo: { id: 1, full_name: repository } },
        });
      if (init?.method === "POST") {
        const item = {
          id: comments.length + 1,
          user: { id: 42 },
          body: JSON.parse(String(init.body)).body,
        };
        comments.push(item);
        return Response.json(item);
      }
      if (init?.method === "PATCH") {
        comments[0].body = JSON.parse(String(init.body)).body;
        return Response.json(comments[0]);
      }
      return Response.json(comments);
    };
    const run = createBudgetWorkflow({
      fetch: api,
      prepare: async () => {
        if (reason === "infra") throw new Error("secret");
      },
      model: async () => {
        throw new ReviewFailure(reason === "infra" ? "agent_failed" : reason);
      },
    });
    const result = await run({
      kind: "review",
      eventName: "pull_request",
      event: {
        action: "opened",
        repository: { full_name: repository },
        pull_request: { number: 7 },
      },
      repository,
      owner: "owner",
      token: "token",
      authorId: 42,
      actionsUrl: "https://github.com/owner/repo/actions/runs/1",
    });
    expect(result).toMatchObject({ status: reason, number: 7, sha });
    const publish = () =>
      publishReview({
        fetch: api,
        repository,
        token: "token",
        authorId: 42,
        number: 7,
        sha,
        artifact: "review-1-1",
        report: { failure: reason },
      });
    head = "b".repeat(40);
    await expect(publish()).rejects.toThrow();
    head = sha;
    await publish();
    await publish();
    const reports = comments.filter((item) => item.body.includes("opencode-review-report"));
    expect(reports).toHaveLength(1);
    expect(reports[0].body).toContain(`Review stopped: ${reason}. Human attention required.`);
    expect(reports[0].body).toContain(sha);
    expect(reports[0].body).toContain("/actions/runs/1/attempts/1");
    expect(reports[0].body).not.toMatch(/secret|no confirmed defects/i);
  },
);

test("trusted PR event produces a separately published review, while a stale head cannot be published", async () => {
  const dir = await mkdtemp(join(tmpdir(), "review-integration-"));
  const sha = "a".repeat(40);
  const repository = "ignateff/ai-for-developers-project-387";
  const comments: { id: number; user: { id: number }; body: string }[] = [];
  let head = sha;
  let calls = 0;
  const pr = () => ({
    number: 7,
    state: "open",
    draft: false,
    changed_files: 1,
    body: "Booking request #33",
    user: { type: "User", login: "ignateff" },
    base: { sha: "b".repeat(40), repo: { id: 1, full_name: repository } },
    head: { sha: head, repo: { id: 1, full_name: repository } },
  });
  const api: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path.endsWith("/pulls/7")) return Response.json(pr());
    if (path.endsWith("/pulls/7/files"))
      return Response.json([{ filename: "booking.ts", status: "added" }]);
    if (path.includes("/contents/"))
      return Response.json({ type: "file", encoding: "base64", content: "eA==", size: 1 });
    if (path.endsWith("/issues/33"))
      return Response.json({ title: "Booking", body: "Book a slot" });
    if (path.endsWith("/issues/7/comments") && init?.method === "POST") {
      const comment = {
        id: comments.length + 1,
        user: { id: 42 },
        body: JSON.parse(String(init.body)).body,
      };
      comments.push(comment);
      return Response.json(comment, { status: 201 });
    }
    const comment = comments.find((item) => path.endsWith(`/issues/comments/${item.id}`));
    if (comment && init?.method === "PATCH") {
      comment.body = JSON.parse(String(init.body)).body;
      return Response.json(comment);
    }
    if (comment && init?.method === "DELETE") {
      comments.splice(comments.indexOf(comment), 1);
      return new Response(null, { status: 204 });
    }
    if (path.endsWith("/issues/7/comments")) return Response.json(comments);
    return new Response(null, { status: 404 });
  };
  const env = {
    RUNNER_TEMP: dir,
    GITHUB_RUN_ID: "1",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_REPOSITORY: repository,
    GH_TOKEN: "fixture-token",
    DEEPSEEK_API_KEY: "fixture-key",
    OPENCODE_PR_NUMBER: "7",
    OPENCODE_HEAD_SHA: sha,
    OPENCODE_REVIEW_ARTIFACT: "review-1-1",
  };
  try {
    const run = createProductionWorkflow({
      fetch: api,
      prepare: async () => {
        await mkdir(join(dir, "opencode-review-1-1"));
        await writeFile(join(dir, "opencode-review-1-1", "binary"), "/fixture");
      },
      model: async (identity) => {
        expect(identity).toEqual({ number: 7, sha });
        await reviewWorkflow("run", env, {
          fetch: api,
          review: async ({ context }) => {
            calls++;
            expect(JSON.stringify(context)).toContain("Book a slot");
            return { summary: "No confirmed defects", findings: [], limitations: [] };
          },
        });
      },
    });
    expect(
      (
        await run({
          kind: "review",
          eventName: "pull_request",
          event: {
            action: "opened",
            repository: { full_name: repository },
            pull_request: { number: 7 },
          },
          repository,
          owner: "ignateff",
          token: "fixture-token",
          authorId: 42,
          actionsUrl: `https://github.com/${repository}/actions/runs/1`,
        })
      ).status,
    ).toBe("completed");
    const reportPath = join(dir, "opencode-review-1-1", "review.json");
    const publish = () =>
      publishWorkflow({
        env,
        fetch: api,
        authorId: 42,
        readReport: async () => JSON.parse(await readFile(reportPath, "utf8")),
      });
    head = "c".repeat(40);
    await expect(publish()).rejects.toThrow();
    expect(comments.some((comment) => comment.body.includes("opencode-review-report"))).toBe(false);
    head = sha;
    await publish();
    await publish();
    const reports = comments.filter((comment) => comment.body.includes("opencode-review-report"));
    expect(reports).toHaveLength(1);
    expect(reports[0].body).toContain(sha);
    expect(reports[0].body).toContain("No confirmed defects");
    expect(reports[0].body).toContain(`/actions/runs/1/attempts/1`);
    expect(
      comments.find((comment) => comment.body.includes("opencode-pr-attempt-budget"))?.body,
    ).toContain('"review":1');
    expect(calls).toBe(1);

    // Exercise the actual CLI and collector with fixture GitHub responses: slow
    // context collection must not reach the real runtime or publish directly.
    const started = Date.now();
    const clock = vi.spyOn(Date, "now");
    const eventPath = join(dir, "event.json");
    await writeFile(
      eventPath,
      JSON.stringify({
        action: "opened",
        repository: { full_name: repository },
        pull_request: { number: 7 },
      }),
    );
    try {
      const result = await runBudgetCli({
        kind: "review",
        authorId: 42,
        env: {
          ...env,
          GITHUB_RUN_ID: "2",
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_OUTPUT: join(dir, "output"),
          GITHUB_EVENT_NAME: "pull_request",
          GITHUB_REPOSITORY_OWNER: "ignateff",
          OPENCODE_REVIEW_STARTED_AT: String(started),
        },
        fetch: async (input, init) => {
          if (String(input).includes("/contents/")) clock.mockReturnValue(started + 8 * 60_000);
          return api(input, init);
        },
        prepare: async () => {
          await mkdir(join(dir, "opencode-review-2-1"));
          await writeFile(join(dir, "opencode-review-2-1", "binary"), "/must-not-run");
        },
      });
      expect(result.status).toBe("infra");
      expect(
        JSON.parse(await readFile(join(dir, "opencode-review-2-1", "review.json"), "utf8")),
      ).toEqual({ failure: "infra" });
      expect(comments.filter((item) => item.body.includes("opencode-review-report"))).toHaveLength(
        1,
      );
    } finally {
      clock.mockRestore();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

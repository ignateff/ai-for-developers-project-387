import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { parse } from "yaml";
import { reviewWorkflow } from "./opencode-review-workflow";
import { createProductionWorkflow } from "./opencode-production-workflow";

test("review collects linked requirements and identifies an unconfirmed agreement", async () => {
  const dir = await mkdtemp(join(tmpdir(), "review-context-"));
  const sha = "a".repeat(40),
    base = "b".repeat(40);
  try {
    await mkdir(join(dir, "opencode-review-1-1"));
    await writeFile(join(dir, "opencode-review-1-1", "binary"), "/fixture");
    const pr = {
      number: 7,
      state: "open",
      draft: false,
      changed_files: 1,
      body: "Request: #33\nAgreement: https://github.com/ignateff/ai-for-developers-project-386/issues/2#issuecomment-123",
      base: { sha: base, repo: { id: 1, full_name: "ignateff/ai-for-developers-project-387" } },
      head: { sha, repo: { id: 1, full_name: "ignateff/ai-for-developers-project-387" } },
    };
    const api: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/pulls/7")) return Response.json(pr);
      if (url.pathname.endsWith("/pulls/7/files"))
        return Response.json([{ filename: "a", status: "added" }]);
      if (url.pathname.includes("/contents/"))
        return Response.json({ type: "file", encoding: "base64", content: "eA==", size: 1 });
      if (url.pathname.endsWith("/issues/33"))
        return Response.json({ title: "Booking", body: "Booking requirements" });
      if (url.pathname.endsWith("/issues/comments/123"))
        return Response.json({
          body: "Approved requirements",
          user: { login: "reviewer", type: "Bot" },
          issue_url: "https://api.github.com/repos/ignateff/ai-for-developers-project-386/issues/2",
          html_url:
            "https://github.com/ignateff/ai-for-developers-project-386/issues/2#issuecomment-123",
        });
      return new Response(null, { status: 404 });
    };
    let snapshot = "";
    const stages: string[] = [];
    await reviewWorkflow(
      "run",
      {
        RUNNER_TEMP: dir,
        GITHUB_RUN_ID: "1",
        GITHUB_RUN_ATTEMPT: "1",
        DEEPSEEK_API_KEY: "model-secret",
        GH_TOKEN: "github-secret",
        GITHUB_REPOSITORY: "ignateff/ai-for-developers-project-387",
        OPENCODE_PR_NUMBER: "7",
        OPENCODE_HEAD_SHA: sha,
      },
      {
        fetch: api,
        progress: (stage) => stages.push(stage),
        review: async ({ context }) => {
          snapshot = JSON.stringify(context);
          return { summary: "No confirmed defects", findings: [], limitations: [] };
        },
      },
    );
    expect(snapshot).toContain("Booking requirements");
    expect(snapshot).toContain("Approved requirements");
    expect(snapshot).toContain("unconfirmed");
    expect(JSON.parse(snapshot).agreement.sources[0]).toMatchObject({
      eligible: false,
      explicitlyLinkedInPr: true,
      status: "unconfirmed",
    });
    expect(snapshot).not.toContain("Eligible human author");
    expect(snapshot).not.toContain("github-secret");
    expect(snapshot).not.toContain("model-secret");
    expect(stages).toEqual([
      "PR context collection started",
      "changed file collection started",
      "supplementary context collection started",
      "final context validation started",
      "model invocation started",
      "model invocation complete",
    ]);
    expect(stages.join(" ")).not.toContain("secret");
    const report = JSON.parse(
      await readFile(join(dir, "opencode-review-1-1", "review.json"), "utf8"),
    );
    expect(report.limitations.join(" ")).toContain("CI context is incomplete");
    expect(report.limitations.join(" ")).toContain("Previous review");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test.each([
  [{ check_runs: "invalid" }, { state: "success", statuses: [] }],
  [
    { total_count: 2, check_runs: [{ name: "one", status: "completed" }] },
    { state: "success", statuses: [] },
  ],
  [
    { total_count: 1, check_runs: [null] },
    { state: "success", statuses: [] },
  ],
  [
    { total_count: 1, check_runs: [{ name: "one", status: "in_progress" }] },
    { state: "success", statuses: [] },
  ],
  [{ check_runs: [] }, { state: "success", statuses: [] }],
  [
    { total_count: 0, check_runs: [] },
    { state: "success", statuses: [{}] },
  ],
  [
    { total_count: 0, check_runs: [] },
    { state: "bogus", statuses: [] },
  ],
])("review reports malformed or incomplete CI data as incomplete", async (checkRuns, statuses) => {
  const dir = await mkdtemp(join(tmpdir(), "review-ci-"));
  const sha = "a".repeat(40),
    base = "b".repeat(40);
  try {
    await mkdir(join(dir, "opencode-review-1-1"));
    await writeFile(join(dir, "opencode-review-1-1", "binary"), "/fixture");
    const api: typeof fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/pulls/7"))
        return Response.json({
          number: 7,
          state: "open",
          draft: false,
          changed_files: 1,
          base: { sha: base, repo: { id: 1, full_name: "owner/repo" } },
          head: { sha, repo: { id: 1, full_name: "owner/repo" } },
        });
      if (path.endsWith("/pulls/7/files"))
        return Response.json([{ filename: "a", status: "added" }]);
      if (path.includes("/contents/"))
        return Response.json({ type: "file", encoding: "base64", content: "eA==", size: 1 });
      if (path.endsWith("/check-runs")) return Response.json(checkRuns);
      if (path.endsWith("/status")) return Response.json(statuses);
      return Response.json([]);
    };
    await reviewWorkflow(
      "run",
      {
        RUNNER_TEMP: dir,
        GITHUB_RUN_ID: "1",
        GITHUB_RUN_ATTEMPT: "1",
        DEEPSEEK_API_KEY: "fixture",
        GH_TOKEN: "fixture",
        GITHUB_REPOSITORY: "owner/repo",
        OPENCODE_PR_NUMBER: "7",
        OPENCODE_HEAD_SHA: sha,
      },
      {
        fetch: api,
        review: async () => ({ summary: "No confirmed defects", findings: [], limitations: [] }),
      },
    );
    const report = JSON.parse(
      await readFile(join(dir, "opencode-review-1-1", "review.json"), "utf8"),
    );
    expect(report.limitations.join(" ")).toContain("context is incomplete");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("collects bounded nested evidence, pinned base docs and paginated CI without inferring approval", async () => {
  const dir = await mkdtemp(join(tmpdir(), "review-evidence-"));
  const sha = "a".repeat(40),
    base = "b".repeat(40);
  const requested: string[] = [];
  try {
    await mkdir(join(dir, "opencode-review-1-1"));
    await writeFile(join(dir, "opencode-review-1-1", "binary"), "/fixture");
    const api: typeof fetch = async (input) => {
      const url = new URL(String(input));
      requested.push(url.href);
      const path = url.pathname;
      if (path.endsWith("/pulls/7"))
        return Response.json({
          number: 7,
          state: "open",
          draft: false,
          changed_files: 1,
          body: "#33",
          base: { sha: base, repo: { id: 1, full_name: "ignateff/ai-for-developers-project-387" } },
          head: { sha, repo: { id: 1, full_name: "ignateff/ai-for-developers-project-387" } },
        });
      if (path.endsWith("/pulls/7/files"))
        return Response.json([{ filename: "a", status: "added" }]);
      if (path.includes("/contents/"))
        return Response.json({ type: "file", encoding: "base64", content: "eA==", size: 1 });
      if (path.endsWith("/issues/33"))
        return Response.json({
          title: "one",
          body: "Nested #34 and https://example.com/spec and [spec](docs/spec.md)",
        });
      if (path.endsWith("/issues/34"))
        return Response.json({
          title: "two",
          body: "https://github.com/ignateff/ai-for-developers-project-386/issues/2#issuecomment-123",
        });
      if (path.endsWith("/issues/2"))
        return Response.json({
          title: "history",
          body: "Historical requirement [doc](docs/historical.md)",
        });
      if (path.endsWith("/issues/comments/123"))
        return Response.json({
          body: "ok",
          user: { login: "human", type: "User" },
          issue_url: "https://api.github.com/repos/ignateff/ai-for-developers-project-386/issues/2",
        });
      if (path.endsWith("/collaborators/human/permission"))
        return Response.json({ permission: "write" });
      if (path.endsWith("/check-runs"))
        return Response.json({
          total_count: 101,
          check_runs:
            url.searchParams.get("page") === "1"
              ? Array(100).fill({ name: "pending", status: "in_progress", conclusion: null })
              : [{ name: "last", status: "completed", conclusion: "success" }],
        });
      if (path.endsWith("/status")) return Response.json({ state: "pending", statuses: [] });
      if (path.endsWith("/pulls/7/comments"))
        return Response.json([
          {
            body: "old finding",
            path: "src/a.ts",
            line: 12,
            original_line: 9,
            side: "RIGHT",
            commit_id: "c".repeat(40),
            diff_hunk: "@@ -1 +1 @@",
          },
        ]);
      return Response.json([]);
    };
    let snapshot: any;
    await reviewWorkflow(
      "run",
      {
        RUNNER_TEMP: dir,
        GITHUB_RUN_ID: "1",
        GITHUB_RUN_ATTEMPT: "1",
        DEEPSEEK_API_KEY: "secret-model",
        GH_TOKEN: "secret-token",
        GITHUB_REPOSITORY: "ignateff/ai-for-developers-project-387",
        OPENCODE_PR_NUMBER: "7",
        OPENCODE_HEAD_SHA: sha,
      },
      {
        fetch: api,
        review: async ({ context }) => {
          snapshot = context;
          return { summary: "No confirmed defects", findings: [], limitations: [] };
        },
      },
    );
    expect(snapshot.requirements.text).toContain("Historical requirement");
    expect(requested.some((url) => url.includes(`/contents/docs/spec.md?ref=${base}`))).toBe(true);
    expect(snapshot.agreement.sources).toContainEqual(
      expect.objectContaining({ source: "docs/spec.md", explicitlyLinkedInPr: false }),
    );
    expect(snapshot.requirements.text).toContain("AGENTS.md");
    expect(snapshot.agreement.sources[0]).toMatchObject({
      eligible: true,
      status: "unconfirmed",
      explicitlyLinkedInPr: false,
      text: "ok",
    });
    expect(snapshot.agreement.limitations.join(" ")).toContain("External or unsupported");
    expect(snapshot.agreement.limitations.join(" ")).not.toContain("CI context is incomplete");
    expect(snapshot.agreement.limitations.join(" ")).toContain("relative document link");
    expect(requested.some((url) => url.includes("/contents/docs/historical.md"))).toBe(false);
    expect(snapshot.previousReview.reviewComments[0]).toMatchObject({
      path: "src/a.ts",
      line: 12,
      originalLine: 9,
      side: "RIGHT",
      commit: "c".repeat(40),
      diffHunk: "@@ -1 +1 @@",
    });
    expect(snapshot.ci.checks).toHaveLength(101);
    expect(snapshot.ci.status).toBe("pending");
    expect(requested.filter((url) => url.includes("/contents/AGENTS.md"))[0]).toContain(
      `ref=${base}`,
    );
    expect(requested.some((url) => url.includes("example.com"))).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("production review admits then calls runtime with changed file contents pinned to base and head", async () => {
  const dir = await mkdtemp(join(tmpdir(), "review-adapter-"));
  try {
    const comments: { id: number; user: { id: number }; body: string }[] = [];
    let id = 1,
      calls = 0;
    let failSource = false;
    const requestedRefs: string[] = [];
    const sha = "a".repeat(40),
      base = "b".repeat(40);
    const pr = {
      number: 7,
      state: "open",
      draft: false,
      changed_files: 1,
      user: { type: "User", login: "owner" },
      base: { sha: base, repo: { id: 1, full_name: "owner/repo" } },
      head: { sha, repo: { id: 1, full_name: "owner/repo" } },
    };
    const api: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/pulls/7/files"))
        return Response.json([{ filename: "src/a.ts", status: "modified", patch: "-old\n+new" }]);
      if (url.pathname.includes("/contents/")) {
        if (failSource) return new Response(null, { status: 404 });
        requestedRefs.push(url.searchParams.get("ref") ?? "");
        const s = url.searchParams.get("ref") === base ? "old source" : "new source";
        return Response.json({
          type: "file",
          encoding: "base64",
          content: Buffer.from(s).toString("base64"),
          size: Buffer.byteLength(s),
        });
      }
      if (url.pathname.endsWith("/pulls/7")) return Response.json(pr);
      if (init?.method === "POST") {
        const c = { id: id++, user: { id: 42 }, body: JSON.parse(String(init.body)).body };
        comments.push(c);
        return Response.json(c, { status: 201 });
      }
      const i = comments.findIndex(
        (c) => c.id === Number(url.pathname.match(/comments\/(\d+)/)?.[1]),
      );
      if (init?.method === "DELETE") {
        comments.splice(i, 1);
        return new Response(null, { status: 204 });
      }
      if (init?.method === "PATCH") {
        comments[i].body = JSON.parse(String(init.body)).body;
        return Response.json(comments[i]);
      }
      return Response.json(comments);
    };
    const env = {
      RUNNER_TEMP: dir,
      GITHUB_RUN_ID: "1",
      GITHUB_RUN_ATTEMPT: "1",
      DEEPSEEK_API_KEY: "fixture",
      GH_TOKEN: "fixture",
      GITHUB_REPOSITORY: "owner/repo",
    };
    const run = createProductionWorkflow({
      fetch: api,
      prepare: async () => {
        const root = join(dir, `opencode-review-1-${env.GITHUB_RUN_ATTEMPT}`);
        await mkdir(root);
        await writeFile(join(root, "binary"), "/fixture");
      },
      model: async (identity) => {
        await reviewWorkflow(
          "run",
          { ...env, OPENCODE_PR_NUMBER: String(identity.number), OPENCODE_HEAD_SHA: identity.sha },
          {
            fetch: api,
            review: async ({ context }) => {
              calls++;
              expect(JSON.stringify(context.changes)).toContain("old source");
              expect(JSON.stringify(context.changes)).toContain("new source");
              expect(JSON.stringify(context.requirements)).toContain("REVIEW.md");
              expect(context.baseSha).toBe(base);
              expect(context.headSha).toBe(sha);
              return { summary: "No confirmed defects", findings: [], limitations: ["fixture"] };
            },
          },
        );
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
      token: "fixture",
      authorId: 42,
      actionsUrl: "",
    };
    const result = await run(options);
    expect(result.status).toBe("completed");
    expect(calls).toBe(1);
    expect(requestedRefs).toEqual([base, sha, base, base, base, base]);
    expect(comments[0].body).toContain('"review":1');
    const report = JSON.parse(
      await readFile(join(dir, "opencode-review-1-1", "review.json"), "utf8"),
    );
    expect(report.limitations.join(" ")).toContain("Only changed files");
    env.GITHUB_RUN_ATTEMPT = "2";
    failSource = true;
    expect((await run(options)).status).toBe("infra");
    expect(calls).toBe(1);
    expect(comments[0].body).toContain('"review":2');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("review model job spends inside the rerun job without holding the budget queue", () => {
  const workflow = parse(readFileSync(".github/workflows/opencode-review.yml", "utf8"));
  const job = workflow.jobs.review;
  expect(job.permissions).toMatchObject({ issues: "read", "pull-requests": "write" });
  expect(workflow.jobs.publish.permissions).toMatchObject({
    issues: "read",
    "pull-requests": "write",
  });
  expect(job.if).toBeUndefined();
  expect(job.concurrency.group).toBe("opencode-review-${{ github.event.pull_request.number }}");
  expect(job.concurrency["cancel-in-progress"]).toBe(true);
  const model = job.steps.findIndex((s: { id?: string }) => s.id === "workflow");
  expect(model).toBeGreaterThan(-1);
  expect(job.steps[model].run).toBe("mise run opencode:budget review");
  expect(JSON.stringify(job.steps.slice(0, model))).not.toContain("secrets.");
  const publish = workflow.jobs.publish;
  expect(publish.needs).toBe("review");
  expect(publish.if).toBe("${{ !cancelled() && needs.review.outputs.artifact != '' }}");
  expect(JSON.stringify(publish)).not.toContain("DEEPSEEK_API_KEY");
  expect(JSON.stringify(publish)).not.toContain("opencode:budget");
  expect(JSON.stringify(publish)).not.toContain("opencode:review-run");
});

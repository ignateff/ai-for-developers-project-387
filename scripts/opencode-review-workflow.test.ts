import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { parse } from "yaml";
import { reviewWorkflow } from "./opencode-review-workflow";
import { createProductionWorkflow } from "./opencode-production-workflow";
import { defaultOpenCodeModel } from "./opencode-model";

test("review requires the credential that matches the configured provider", async () => {
  const env = {
    RUNNER_TEMP: "/tmp",
    GITHUB_RUN_ID: "1",
    GITHUB_RUN_ATTEMPT: "1",
  };
  await expect(
    reviewWorkflow("run", {
      ...env,
      OPENCODE_MODEL: "deepseek/deepseek-flash",
      OPENCODE_API_KEY: "wrong-provider-key",
    }),
  ).rejects.toThrow(/DEEPSEEK_API_KEY is required/);
  await expect(
    reviewWorkflow("run", { ...env, OPENCODE_MODEL: "deepseek/deepseek-flash; id" }),
  ).rejects.toThrow(/OpenCode model configuration is invalid/);
  await expect(reviewWorkflow("run", env)).rejects.toThrow(/OPENCODE_API_KEY is required/);
});

test("review uses the shared default model when OPENCODE_MODEL is unset", async () => {
  expect(defaultOpenCodeModel).toBe("opencode-go/deepseek-v4.1-flash");
});

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
      changed_files: 2,
      body: "Request: #33\nAgreement: https://github.com/ignateff/ai-for-developers-project-386/issues/2#issuecomment-123",
      base: { sha: base, repo: { id: 1, full_name: "ignateff/ai-for-developers-project-387" } },
      head: { sha, repo: { id: 1, full_name: "ignateff/ai-for-developers-project-387" } },
    };
    const api: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/pulls/7")) return Response.json(pr);
      if (url.pathname.endsWith("/pulls/7/files"))
        return Response.json([
          { filename: "a", status: "added" },
          { filename: "image.png", status: "added" },
        ]);
      if (url.pathname.endsWith("/contents/image.png"))
        return Response.json({ type: "file", encoding: "base64", content: "iVBORw==", size: 4 });
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
        OPENCODE_API_KEY: "model-secret",
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
          return { summary: "Подтверждённых дефектов не найдено.", findings: [], limitations: [] };
        },
      },
    );
    expect(snapshot).toContain("Booking requirements");
    expect(snapshot).toContain("image.png");
    expect(snapshot).toContain("Двоичное содержимое не проверялось");
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
      "related repository context collection started",
      "supplementary context collection started",
      "final context validation started",
      "model invocation started",
      "model invocation complete",
    ]);
    expect(stages.join(" ")).not.toContain("secret");
    const report = JSON.parse(
      await readFile(join(dir, "opencode-review-1-1", "review.json"), "utf8"),
    );
    expect(report.limitations.join(" ")).toContain("Контекст CI неполон");
    expect(report.limitations.join(" ")).toContain("Контекст предыдущих ревью");
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
        OPENCODE_API_KEY: "fixture",
        GH_TOKEN: "fixture",
        GITHUB_REPOSITORY: "owner/repo",
        OPENCODE_PR_NUMBER: "7",
        OPENCODE_HEAD_SHA: sha,
      },
      {
        fetch: api,
        review: async () => ({
          summary: "Подтверждённых дефектов не найдено.",
          findings: [],
          limitations: [],
        }),
      },
    );
    const report = JSON.parse(
      await readFile(join(dir, "opencode-review-1-1", "review.json"), "utf8"),
    );
    expect(report.limitations.join(" ")).toContain("неполон");
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
        OPENCODE_API_KEY: "secret-model",
        GH_TOKEN: "secret-token",
        GITHUB_REPOSITORY: "ignateff/ai-for-developers-project-387",
        OPENCODE_PR_NUMBER: "7",
        OPENCODE_HEAD_SHA: sha,
      },
      {
        fetch: api,
        review: async ({ context }) => {
          snapshot = context;
          return { summary: "Подтверждённых дефектов не найдено.", findings: [], limitations: [] };
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
    expect(snapshot.limitations.join(" ")).toContain("Внешние или неподдерживаемые");
    expect(snapshot.limitations.join(" ")).not.toContain("Контекст CI неполон");
    expect(snapshot.limitations.join(" ")).toContain("Относительную ссылку на документ");
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
      OPENCODE_API_KEY: "fixture",
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
              return {
                summary: "Подтверждённых дефектов не найдено.",
                findings: [],
                limitations: ["fixture"],
              };
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
    expect(report.limitations.join(" ")).toContain("Контекст связанных файлов репозитория");
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
  expect(job.steps[model].env.OPENCODE_MODEL).toBe("${{ vars.OPENCODE_MODEL }}");
  expect(job.steps[model].env.OPENCODE_API_KEY).toBe("${{ secrets.OPENCODE_API_KEY }}");
  expect(job.steps[model].env.DEEPSEEK_API_KEY).toBe("${{ secrets.DEEPSEEK_API_KEY }}");
  expect(JSON.stringify(job.steps.slice(0, model))).not.toContain("secrets.");
  const publish = workflow.jobs.publish;
  expect(publish.needs).toBe("review");
  expect(publish.if).toBe("${{ !cancelled() && needs.review.outputs.artifact != '' }}");
  expect(JSON.stringify(publish)).not.toContain("DEEPSEEK_API_KEY");
  expect(JSON.stringify(publish)).not.toContain("opencode:budget");
  expect(JSON.stringify(publish)).not.toContain("opencode:review-run");
});

const blob = (character: string) => character.repeat(40);
const treeBlob = (path: string, sha: string, size: number) => ({
  path,
  mode: "100644",
  type: "blob",
  sha,
  size,
});

test("collects pinned base and head trees with unchanged related files needed to verify the diff", async () => {
  const dir = await mkdtemp(join(tmpdir(), "review-related-"));
  const sha = "a".repeat(40),
    base = "b".repeat(40);
  const changed = "apps/web/src/pages/book/availability.tsx";
  const format = "apps/web/src/shared/format.ts";
  const calendar = "apps/web/src/shared/calendar.tsx";
  const helper = "apps/web/src/shared/helper.ts";
  const testFile = "apps/web/src/pages/book/availability.test.tsx";
  const importer = "apps/web/src/widgets/book-widget.tsx";
  const unrelated = "apps/web/src/widgets/other.tsx";
  const baseChanged = blob("1");
  const headChanged = blob("2");
  const sources: Record<string, string> = {
    [changed]:
      'import { formatTime } from "../../shared/format";\nimport { Calendar } from "../../shared/calendar";\nimport { helper } from "../../shared/helper";\nexport const availability = formatTime;',
    [format]: "export const formatTime = (minutes: number) => String(minutes);",
    [calendar]: "export const Calendar = () => null;",
    [helper]: "export const helper = 1;",
    [testFile]: 'import { availability } from "./availability";',
    [importer]: 'import { availability } from "../pages/book/availability";',
    [unrelated]: "export const other = 1;",
  };
  const pr = {
    number: 7,
    state: "open",
    draft: false,
    changed_files: 1,
    body: "Request: #33",
    base: { sha: base, repo: { id: 1, full_name: "ignateff/ai-for-developers-project-387" } },
    head: { sha, repo: { id: 1, full_name: "ignateff/ai-for-developers-project-387" } },
  };
  const tree = (ref: string) => ({
    sha: ref,
    truncated: false,
    tree: [
      treeBlob("AGENTS.md", blob("3"), 10),
      treeBlob(changed, ref === base ? baseChanged : headChanged, sources[changed].length),
      treeBlob(format, blob("4"), sources[format].length),
      treeBlob(calendar, blob("5"), sources[calendar].length),
      treeBlob(helper, ref === base ? blob("e") : blob("f"), sources[helper].length),
      treeBlob(testFile, blob("6"), sources[testFile].length),
      treeBlob(importer, blob("7"), sources[importer].length),
      treeBlob(unrelated, blob("8"), sources[unrelated].length),
      { path: "apps/web/src", mode: "040000", type: "tree", sha: blob("9") },
    ],
  });
  const api: typeof fetch = async (input) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path.endsWith("/pulls/7")) return Response.json(pr);
    if (path.endsWith("/pulls/7/files"))
      return Response.json([{ filename: changed, status: "modified", patch: "-a\n+b" }]);
    if (path.includes("/git/trees/")) return Response.json(tree(path.split("/git/trees/")[1]));
    if (path.endsWith("/pulls/7/commits"))
      return Response.json([
        {
          sha: blob("d"),
          commit: { message: "fix: address prior review" },
          author: { login: "owner" },
        },
      ]);
    if (path.includes("/contents/")) {
      const name = decodeURIComponent(path.split("/contents/")[1]);
      if (name.endsWith("REVIEW.md")) {
        const review = "Calendar review criteria";
        return Response.json({
          type: "file",
          encoding: "base64",
          content: Buffer.from(review).toString("base64"),
          size: Buffer.byteLength(review),
        });
      }
      const content = sources[name];
      if (!content) return new Response(null, { status: 404 });
      return Response.json({
        type: "file",
        encoding: "base64",
        content: Buffer.from(content).toString("base64"),
        size: Buffer.byteLength(content),
      });
    }
    if (path.endsWith("/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
    if (path.endsWith("/status")) return Response.json({ state: "success", statuses: [] });
    if (path.endsWith("/issues/33"))
      return Response.json({ title: "Requirements", body: "Booking requirements" });
    return Response.json([]);
  };
  try {
    await mkdir(join(dir, "opencode-review-1-1"));
    await writeFile(join(dir, "opencode-review-1-1", "binary"), "/fixture");
    let snapshot: any;
    await reviewWorkflow(
      "run",
      {
        RUNNER_TEMP: dir,
        GITHUB_RUN_ID: "1",
        GITHUB_RUN_ATTEMPT: "1",
        OPENCODE_API_KEY: "fixture-key",
        GH_TOKEN: "fixture-token",
        GITHUB_REPOSITORY: "ignateff/ai-for-developers-project-387",
        OPENCODE_PR_NUMBER: "7",
        OPENCODE_HEAD_SHA: sha,
      },
      {
        fetch: api,
        review: async ({ context }) => {
          snapshot = context;
          return { summary: "Подтверждённых дефектов не найдено.", findings: [], limitations: [] };
        },
      },
    );
    const repository = snapshot.repository;
    expect(repository).toMatchObject({ baseSha: base, headSha: sha, available: true });
    const index = (ref: "base" | "head") =>
      new Map(repository.index[ref].map((entry: { path: string }) => [entry.path, entry]));
    expect(index("head").has(changed)).toBe(true);
    expect((index("base").get(changed) as { sha: string }).sha).toBe(baseChanged);
    expect((index("head").get(changed) as { sha: string }).sha).toBe(headChanged);
    const related = new Map(
      repository.related.map((entry: { path: string }) => [entry.path, entry]),
    );
    expect([...related.keys()]).toEqual(
      expect.arrayContaining([format, calendar, testFile, importer]),
    );
    expect(related.has(unrelated)).toBe(false);
    expect(related.has(helper)).toBe(false);
    expect(related.get(format)).toMatchObject({
      content: sources[format],
      sha: blob("4"),
      reason: `Imported by changed file ${changed}.`,
    });
    expect(related.get(importer)).toMatchObject({
      content: sources[importer],
      reason: `References changed file ${changed}.`,
    });
    expect(related.get(testFile)).toMatchObject({
      content: sources[testFile],
      sha: blob("6"),
      reason: `Test for changed file ${changed}.`,
    });
    expect((index("base").get(format) as { sha: string }).sha).toBe(blob("4"));
    expect((index("head").get(format) as { sha: string }).sha).toBe(blob("4"));
    expect(snapshot.ci.headSha).toBe(sha);
    expect(snapshot.commits).toContainEqual({
      sha: blob("d"),
      message: "fix: address prior review",
      author: "owner",
    });
    const saved = JSON.parse(
      await readFile(join(dir, "opencode-review-1-1", "review.json"), "utf8"),
    );
    const limitations = saved.limitations.join(" ");
    expect(limitations).toContain("Контекст связанных файлов репозитория");
    expect(limitations).not.toContain("Контекст связанных файлов репозитория недоступен");
    expect(limitations).toContain("отличается между закреплёнными base и head");
    expect(limitations).not.toContain("только изменённые файлы");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reports an explicit limitation when pinned repository trees are unavailable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "review-related-unavailable-"));
  const sha = "a".repeat(40),
    base = "b".repeat(40);
  const changed = "apps/web/src/pages/book/availability.tsx";
  const pr = {
    number: 7,
    state: "open",
    draft: false,
    changed_files: 1,
    body: "#33",
    base: { sha: base, repo: { id: 1, full_name: "ignateff/ai-for-developers-project-387" } },
    head: { sha, repo: { id: 1, full_name: "ignateff/ai-for-developers-project-387" } },
  };
  const api: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/pulls/7")) return Response.json(pr);
    if (path.endsWith("/pulls/7/files"))
      return Response.json([{ filename: changed, status: "modified", patch: "-a\n+b" }]);
    if (path.includes("/git/trees/")) return new Response(null, { status: 404 });
    if (path.endsWith("/pulls/7/commits")) return Response.json([{}]);
    if (path.includes("/contents/")) {
      const content = "source";
      return Response.json({
        type: "file",
        encoding: "base64",
        content: Buffer.from(content).toString("base64"),
        size: Buffer.byteLength(content),
      });
    }
    if (path.endsWith("/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
    if (path.endsWith("/status")) return Response.json({ state: "success", statuses: [] });
    return Response.json([]);
  };
  try {
    await mkdir(join(dir, "opencode-review-1-1"));
    await writeFile(join(dir, "opencode-review-1-1", "binary"), "/fixture");
    let snapshot: any;
    await reviewWorkflow(
      "run",
      {
        RUNNER_TEMP: dir,
        GITHUB_RUN_ID: "1",
        GITHUB_RUN_ATTEMPT: "1",
        OPENCODE_API_KEY: "fixture-key",
        GH_TOKEN: "fixture-token",
        GITHUB_REPOSITORY: "ignateff/ai-for-developers-project-387",
        OPENCODE_PR_NUMBER: "7",
        OPENCODE_HEAD_SHA: sha,
      },
      {
        fetch: api,
        review: async ({ context }) => {
          snapshot = context;
          return { summary: "Подтверждённых дефектов не найдено.", findings: [], limitations: [] };
        },
      },
    );
    expect(snapshot.repository).toMatchObject({
      available: false,
      index: null,
      related: [],
    });
    const saved = JSON.parse(
      await readFile(join(dir, "opencode-review-1-1", "review.json"), "utf8"),
    );
    const limitations = saved.limitations.join(" ");
    expect(limitations).toContain("Контекст связанных файлов репозитория недоступен");
    expect(limitations).toContain("История коммитов PR неполна или недоступна");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("includes the pinned contract chain for API changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "review-contract-chain-"));
  const sha = "a".repeat(40),
    base = "b".repeat(40);
  const changed = "apps/api/src/bookings/routes.ts";
  const contract = "contract/main.tsp";
  const openapi = "generated/openapi/openapi.yaml";
  const sdk = "generated/sdk/client.ts";
  const contractTest = "apps/api/src/contract.test.ts";
  const localTest = "apps/api/src/bookings/routes.test.ts";
  const sources: Record<string, string> = {
    [changed]: "export const routes = {};",
    [contract]: "op Booking { id: string; }",
    [openapi]: "openapi: 3.0.0",
    [sdk]: "export const generated = 1;",
    [contractTest]: "export const contractTest = 1;",
    [localTest]: "export const localTest = 1;",
  };
  const pr = {
    number: 7,
    state: "open",
    draft: false,
    changed_files: 1,
    body: "#33",
    base: { sha: base, repo: { id: 1, full_name: "ignateff/ai-for-developers-project-387" } },
    head: { sha, repo: { id: 1, full_name: "ignateff/ai-for-developers-project-387" } },
  };
  const entries = Object.fromEntries(
    Object.entries(sources).map(([path, content], index) => [
      path,
      treeBlob(path, blob(String(index + 1)), Buffer.byteLength(content)),
    ]),
  );
  const tree = (changedSha: string) => ({
    sha: changedSha,
    truncated: false,
    tree: Object.values({
      ...entries,
      [changed]: treeBlob(changed, changedSha, Buffer.byteLength(sources[changed])),
    }),
  });
  const api: typeof fetch = async (input) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path.endsWith("/pulls/7")) return Response.json(pr);
    if (path.endsWith("/pulls/7/files"))
      return Response.json([{ filename: changed, status: "modified", patch: "-a\n+b" }]);
    if (path.includes("/git/trees/"))
      return Response.json(tree(path.endsWith(sha) ? blob("2") : blob("1")));
    if (path.includes("/contents/")) {
      const name = decodeURIComponent(path.split("/contents/")[1]);
      const content = sources[name] ?? "base document";
      return Response.json({
        type: "file",
        encoding: "base64",
        content: Buffer.from(content).toString("base64"),
        size: Buffer.byteLength(content),
      });
    }
    if (path.endsWith("/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
    if (path.endsWith("/status")) return Response.json({ state: "success", statuses: [] });
    return Response.json([]);
  };
  try {
    await mkdir(join(dir, "opencode-review-1-1"));
    await writeFile(join(dir, "opencode-review-1-1", "binary"), "/fixture");
    let snapshot: any;
    await reviewWorkflow(
      "run",
      {
        RUNNER_TEMP: dir,
        GITHUB_RUN_ID: "1",
        GITHUB_RUN_ATTEMPT: "1",
        OPENCODE_API_KEY: "fixture-key",
        GH_TOKEN: "fixture-token",
        GITHUB_REPOSITORY: "ignateff/ai-for-developers-project-387",
        OPENCODE_PR_NUMBER: "7",
        OPENCODE_HEAD_SHA: sha,
      },
      {
        fetch: api,
        review: async ({ context }) => {
          snapshot = context;
          return { summary: "Подтверждённых дефектов не найдено.", findings: [], limitations: [] };
        },
      },
    );
    const related = new Map(
      snapshot.repository.related.map((entry: { path: string }) => [entry.path, entry]),
    );
    for (const path of [contract, openapi, sdk, contractTest]) expect(related.has(path)).toBe(true);
    expect(related.get(contract)).toMatchObject({
      content: sources[contract],
      reason: expect.stringContaining("Contract chain"),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("states explicitly when related context is capped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "review-related-cap-"));
  const sha = "a".repeat(40),
    base = "b".repeat(40);
  const directory = "apps/web/src/pages/book";
  const changed = `${directory}/availability.tsx`;
  const modules = Array.from({ length: 25 }, (_, index) => `${directory}/module-${index}.ts`);
  const sources: Record<string, string> = {
    [changed]: modules.map((_, index) => `import "./module-${index}";`).join("\n"),
    ...Object.fromEntries(modules.map((path) => [path, "export const value = 1;"])),
  };
  const pr = {
    number: 7,
    state: "open",
    draft: false,
    changed_files: 1,
    body: "#33",
    base: { sha: base, repo: { id: 1, full_name: "ignateff/ai-for-developers-project-387" } },
    head: { sha, repo: { id: 1, full_name: "ignateff/ai-for-developers-project-387" } },
  };
  const entries = Object.fromEntries(
    Object.entries(sources).map(([path, content], index) => [
      path,
      treeBlob(path, blob(String((index % 9) + 1)), Buffer.byteLength(content)),
    ]),
  );
  const tree = (changedSha: string) => ({
    sha: changedSha,
    truncated: false,
    tree: Object.values({
      ...entries,
      [changed]: treeBlob(changed, changedSha, Buffer.byteLength(sources[changed])),
    }),
  });
  const api: typeof fetch = async (input) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path.endsWith("/pulls/7")) return Response.json(pr);
    if (path.endsWith("/pulls/7/files"))
      return Response.json([{ filename: changed, status: "modified", patch: "-a\n+b" }]);
    if (path.includes("/git/trees/"))
      return Response.json(tree(path.endsWith(sha) ? blob("2") : blob("1")));
    if (path.includes("/contents/")) {
      const name = decodeURIComponent(path.split("/contents/")[1]);
      const content = sources[name] ?? "base document";
      return Response.json({
        type: "file",
        encoding: "base64",
        content: Buffer.from(content).toString("base64"),
        size: Buffer.byteLength(content),
      });
    }
    if (path.endsWith("/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
    if (path.endsWith("/status")) return Response.json({ state: "success", statuses: [] });
    return Response.json([]);
  };
  try {
    await mkdir(join(dir, "opencode-review-1-1"));
    await writeFile(join(dir, "opencode-review-1-1", "binary"), "/fixture");
    let snapshot: any;
    await reviewWorkflow(
      "run",
      {
        RUNNER_TEMP: dir,
        GITHUB_RUN_ID: "1",
        GITHUB_RUN_ATTEMPT: "1",
        OPENCODE_API_KEY: "fixture-key",
        GH_TOKEN: "fixture-token",
        GITHUB_REPOSITORY: "ignateff/ai-for-developers-project-387",
        OPENCODE_PR_NUMBER: "7",
        OPENCODE_HEAD_SHA: sha,
      },
      {
        fetch: api,
        review: async ({ context }) => {
          snapshot = context;
          return { summary: "Подтверждённых дефектов не найдено.", findings: [], limitations: [] };
        },
      },
    );
    expect(snapshot.repository.related.length).toBeLessThanOrEqual(24);
    const saved = JSON.parse(
      await readFile(join(dir, "opencode-review-1-1", "review.json"), "utf8"),
    );
    expect(saved.limitations.join(" ")).toContain("исключены по лимиту количества или размера");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reports a truncated index when the pinned tree exceeds the listing limit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "review-index-limit-"));
  const sha = "a".repeat(40),
    base = "b".repeat(40);
  const changed = "apps/web/src/pages/book/availability.tsx";
  const pr = {
    number: 7,
    state: "open",
    draft: false,
    changed_files: 1,
    body: "#33",
    base: { sha: base, repo: { id: 1, full_name: "ignateff/ai-for-developers-project-387" } },
    head: { sha, repo: { id: 1, full_name: "ignateff/ai-for-developers-project-387" } },
  };
  const tree = (ref: string) => ({
    sha: ref,
    truncated: false,
    tree: [
      ...Array.from({ length: 5000 }, (_, index) =>
        treeBlob(`file-${String(index).padStart(4, "0")}.ts`, blob("a"), 1),
      ),
      treeBlob(changed, ref === base ? blob("1") : blob("2"), 1),
    ],
  });
  const api: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/pulls/7")) return Response.json(pr);
    if (path.endsWith("/pulls/7/files"))
      return Response.json([{ filename: changed, status: "modified", patch: "-a\n+b" }]);
    if (path.includes("/git/trees/")) return Response.json(tree(path.split("/git/trees/")[1]));
    if (path.includes("/contents/")) {
      const content = "x";
      return Response.json({
        type: "file",
        encoding: "base64",
        content: Buffer.from(content).toString("base64"),
        size: Buffer.byteLength(content),
      });
    }
    if (path.endsWith("/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
    if (path.endsWith("/status")) return Response.json({ state: "success", statuses: [] });
    return Response.json([]);
  };
  try {
    await mkdir(join(dir, "opencode-review-1-1"));
    await writeFile(join(dir, "opencode-review-1-1", "binary"), "/fixture");
    await reviewWorkflow(
      "run",
      {
        RUNNER_TEMP: dir,
        GITHUB_RUN_ID: "1",
        GITHUB_RUN_ATTEMPT: "1",
        OPENCODE_API_KEY: "fixture-key",
        GH_TOKEN: "fixture-token",
        GITHUB_REPOSITORY: "ignateff/ai-for-developers-project-387",
        OPENCODE_PR_NUMBER: "7",
        OPENCODE_HEAD_SHA: sha,
      },
      {
        fetch: api,
        review: async () => ({
          summary: "Подтверждённых дефектов не найдено.",
          findings: [],
          limitations: [],
        }),
      },
    );
    const saved = JSON.parse(
      await readFile(join(dir, "opencode-review-1-1", "review.json"), "utf8"),
    );
    expect(saved.limitations.join(" ")).toContain("превышает 5000 записей");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fails closed to the unavailable-context limitation on a malformed pinned tree", async () => {
  const dir = await mkdtemp(join(tmpdir(), "review-malformed-tree-"));
  const sha = "a".repeat(40),
    base = "b".repeat(40);
  const changed = "apps/web/src/pages/book/availability.tsx";
  const pr = {
    number: 7,
    state: "open",
    draft: false,
    changed_files: 1,
    body: "#33",
    base: { sha: base, repo: { id: 1, full_name: "ignateff/ai-for-developers-project-387" } },
    head: { sha, repo: { id: 1, full_name: "ignateff/ai-for-developers-project-387" } },
  };
  const api: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/pulls/7")) return Response.json(pr);
    if (path.endsWith("/pulls/7/files"))
      return Response.json([{ filename: changed, status: "modified", patch: "-a\n+b" }]);
    if (path.includes("/git/trees/"))
      return Response.json({
        sha,
        truncated: false,
        tree: [treeBlob("bad", "not-a-sha", -1)],
      });
    if (path.includes("/contents/")) {
      const content = "x";
      return Response.json({
        type: "file",
        encoding: "base64",
        content: Buffer.from(content).toString("base64"),
        size: Buffer.byteLength(content),
      });
    }
    if (path.endsWith("/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
    if (path.endsWith("/status")) return Response.json({ state: "success", statuses: [] });
    return Response.json([]);
  };
  try {
    await mkdir(join(dir, "opencode-review-1-1"));
    await writeFile(join(dir, "opencode-review-1-1", "binary"), "/fixture");
    let snapshot: any;
    await reviewWorkflow(
      "run",
      {
        RUNNER_TEMP: dir,
        GITHUB_RUN_ID: "1",
        GITHUB_RUN_ATTEMPT: "1",
        OPENCODE_API_KEY: "fixture-key",
        GH_TOKEN: "fixture-token",
        GITHUB_REPOSITORY: "ignateff/ai-for-developers-project-387",
        OPENCODE_PR_NUMBER: "7",
        OPENCODE_HEAD_SHA: sha,
      },
      {
        fetch: api,
        review: async ({ context }) => {
          snapshot = context;
          return { summary: "Подтверждённых дефектов не найдено.", findings: [], limitations: [] };
        },
      },
    );
    expect(snapshot.repository).toMatchObject({ available: false, index: null, related: [] });
    const saved = JSON.parse(
      await readFile(join(dir, "opencode-review-1-1", "review.json"), "utf8"),
    );
    expect(saved.limitations.join(" ")).toContain(
      "Контекст связанных файлов репозитория недоступен",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

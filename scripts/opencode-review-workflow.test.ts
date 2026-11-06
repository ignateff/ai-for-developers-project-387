import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { parse } from "yaml";
import { reviewWorkflow } from "./opencode-review-workflow";
import { createProductionWorkflow } from "./opencode-production-workflow";

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
    expect(requestedRefs).toEqual([base, sha]);
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

test("disabled review model job spends inside the rerun job without holding the budget queue", () => {
  const workflow = parse(readFileSync(".github/workflows/opencode-review.yml", "utf8"));
  const job = workflow.jobs.review;
  expect(job.if).toBe("${{ false }}");
  expect(job.concurrency.group).toBe("opencode-review-${{ github.event.pull_request.number }}");
  expect(job.concurrency["cancel-in-progress"]).toBe(true);
  const model = job.steps.findIndex((s: { id?: string }) => s.id === "workflow");
  expect(model).toBeGreaterThan(-1);
  expect(job.steps[model].run).toBe("mise run opencode:budget review");
  expect(JSON.stringify(job.steps.slice(0, model))).not.toContain("secrets.");
  const publish = workflow.jobs.publish;
  expect(publish.needs).toBe("review");
  expect(publish.if).toBe("needs.review.outputs.artifact != ''");
  expect(JSON.stringify(publish)).not.toContain("DEEPSEEK_API_KEY");
  expect(JSON.stringify(publish)).not.toContain("opencode:budget");
  expect(JSON.stringify(publish)).not.toContain("opencode:review-run");
});

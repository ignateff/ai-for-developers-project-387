import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createProductionWorkflow } from "./opencode-production-workflow.ts";
import { reviewWorkflow } from "./opencode-review-workflow.ts";
import { publishWorkflow } from "./opencode-review-publish-cli.ts";
import { createBudgetWorkflow } from "./opencode-budget-workflow.ts";
import { ReviewFailure } from "./opencode-review-failure.ts";
import { publishReview } from "./opencode-review-publish.ts";
import { runBudgetCli } from "./opencode-budget-cli.ts";
import { parse } from "yaml";

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
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createProductionWorkflow } from "./opencode-production-workflow.ts";
import { reviewWorkflow } from "./opencode-review-workflow.ts";
import { publishWorkflow } from "./opencode-review-publish-cli.ts";

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

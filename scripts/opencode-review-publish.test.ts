import { expect, test } from "vitest";
import { publishWorkflow } from "./opencode-review-publish-cli";

test("publication-only rerun publishes a saved review without budget or model calls", async () => {
  const comments: string[] = [];
  const api: typeof fetch = async (input, init) => {
    if (String(input).includes("/pulls/"))
      return Response.json({ number: 7, head: { sha: "a".repeat(40) } });
    if (init?.method === "POST") {
      comments.push(JSON.parse(String(init.body)).body);
      return Response.json({ id: 1 }, { status: 201 });
    }
    return Response.json(comments.map((body) => ({ body, user: { id: 42 } })));
  };
  const publish = () =>
    publishWorkflow({
      fetch: api,
      authorId: 42,
      env: {
        RUNNER_TEMP: "/tmp",
        GITHUB_REPOSITORY: "owner/repo",
        GH_TOKEN: "token",
        OPENCODE_PR_NUMBER: "7",
        OPENCODE_HEAD_SHA: "a".repeat(40),
        OPENCODE_REVIEW_ARTIFACT: "review-123-1",
      },
      readReport: async () => ({
        summary: "No confirmed defects",
        limitations: ["Requirements unavailable"],
        findings: [],
      }),
    });
  await publish();
  await publish();
  expect(comments).toHaveLength(1);
  expect(comments[0]).toContain("No confirmed defects");
  expect(comments[0]).toContain("Full base/head source snapshots were unavailable");
  expect(comments[0]).toContain("a".repeat(40));
});

test("publication refuses a stale head and does not call the model", async () => {
  let posts = 0;
  const api: typeof fetch = async (_input, init) => {
    if (init?.method === "POST") posts++;
    return Response.json({ number: 7, head: { sha: "b".repeat(40) } });
  };
  const publish = () =>
    publishWorkflow({
      fetch: api,
      authorId: 42,
      env: {
        RUNNER_TEMP: "/tmp",
        GITHUB_REPOSITORY: "owner/repo",
        GH_TOKEN: "token",
        OPENCODE_PR_NUMBER: "7",
        OPENCODE_HEAD_SHA: "a".repeat(40),
        OPENCODE_REVIEW_ARTIFACT: "review-123-1",
      },
      readReport: async () => ({ summary: "No confirmed defects", limitations: [], findings: [] }),
    });
  await expect(publish()).rejects.toThrow();
  expect(posts).toBe(0);
});

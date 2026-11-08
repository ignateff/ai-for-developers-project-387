import { expect, test } from "vitest";
import { publishWorkflow } from "./opencode-review-publish-cli";
import { formatReviewBody } from "./opencode-review-publish";

test("oversize recovery rejects malformed finding structure before contacting GitHub", async () => {
  let calls = 0;
  await expect(
    publishWorkflow({
      fetch: async () => {
        calls++;
        return Response.json({});
      },
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
        summary: "Review",
        limitations: [],
        publicationLimit: true,
        findings: [
          { file: "booking.ts", line: 0, conditions: "x".repeat(12001), consequence: "defect" },
        ],
      }),
    }),
  ).rejects.toThrow();
  expect(calls).toBe(0);
});

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
  expect(comments[0]).toContain("not a full code review");
  expect(comments[0]).toContain("Requirements unavailable");
  expect(comments[0]).toContain("a".repeat(40));
  expect(comments[0]).toContain("https://github.com/owner/repo/actions/runs/123/attempts/1");
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

test("clean review without context limitations keeps the advisory wording", () => {
  const body = formatReviewBody("owner/repo", "a".repeat(40), "review-1-1", {
    summary: "No confirmed defects",
    limitations: [],
    findings: [],
  });
  expect(body).toContain("Advisory review of the pinned head");
  expect(body).not.toContain("not a full code review");
});

test("unavailable context restores the visible non-full-review warning", () => {
  const body = formatReviewBody("owner/repo", "a".repeat(40), "review-1-1", {
    summary: "No confirmed defects",
    limitations: ["Related repository context is unavailable: trees failed."],
    findings: [],
  });
  expect(body).toContain("not a full code review");
});

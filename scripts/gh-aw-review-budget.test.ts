import { describe, expect, test } from "vitest";
import {
  admitReviewAttempt,
  ghAwReviewBudgetMarker,
  githubActionsBotId,
} from "./gh-aw-review-budget";

const sha = "a".repeat(40);
const repository = "ignateff/ai-for-developers-project-387";
const marker = ghAwReviewBudgetMarker;

const budgetBody = (count: number) => `${marker}\n${JSON.stringify({ review: count })}`;

const harness = (seed: number[] = [], pullOverrides: Record<string, unknown> = {}) => {
  const comments: {
    id: number;
    user: { id: number; login: string; type: string };
    body: string;
  }[] = seed.map((count, index) => ({
    id: index + 1,
    user: { id: githubActionsBotId, login: "github-actions[bot]", type: "Bot" },
    body: budgetBody(count),
  }));
  let nextId = comments.length + 1;
  let created = 0;
  let updated = 0;
  const apiFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/pulls/7"))
      return Response.json({
        number: 7,
        state: "open",
        draft: false,
        base: { sha: "b".repeat(40), repo: { id: 1, full_name: repository } },
        head: { sha, repo: { id: 1, full_name: repository } },
        ...pullOverrides,
      });
    if (url.pathname.endsWith("/issues/7/comments") && init?.method === "POST") {
      created++;
      const body = JSON.parse(String(init.body)).body as string;
      const comment = {
        id: nextId++,
        user: { id: githubActionsBotId, login: "github-actions[bot]", type: "Bot" },
        body,
      };
      comments.push(comment);
      return Response.json(comment, { status: 201 });
    }
    if (url.pathname.includes("/issues/7/comments")) {
      const page = Number(url.searchParams.get("page") ?? "1");
      return Response.json(page === 1 ? comments : []);
    }
    if (url.pathname.includes("/issues/comments/") && init?.method === "PATCH") {
      updated++;
      const id = Number(url.pathname.match(/comments\/(\d+)/)?.[1]);
      const comment = comments.find((item) => item.id === id)!;
      comment.body = JSON.parse(String(init.body)).body;
      return Response.json(comment);
    }
    return new Response(null, { status: 404 });
  };
  return { fetch: apiFetch, comments, created: () => created, updated: () => updated };
};

const options = (apiFetch: typeof fetch) => ({
  fetch: apiFetch,
  repository,
  token: "token",
  number: 7,
  expectedHeadSha: sha,
  authorId: githubActionsBotId,
});

describe("gh-aw review attempt budget", () => {
  test("admits three attempts and creates the new counter authoritatively", async () => {
    const first = harness();
    expect(await admitReviewAttempt(options(first.fetch))).toEqual({
      admitted: true,
      reason: "admitted",
      count: 1,
    });
    expect(first.comments).toHaveLength(1);
    expect(first.comments[0].body).toBe(budgetBody(1));
    expect(first.comments[0].user).toMatchObject({ id: githubActionsBotId });

    expect(await admitReviewAttempt(options(first.fetch))).toEqual({
      admitted: true,
      reason: "admitted",
      count: 2,
    });
    expect(await admitReviewAttempt(options(first.fetch))).toEqual({
      admitted: true,
      reason: "admitted",
      count: 3,
    });
    expect(await admitReviewAttempt(options(first.fetch))).toEqual({
      admitted: false,
      reason: "limit_exhausted",
      count: 3,
    });
    expect(first.comments).toHaveLength(1);
    expect(first.comments[0].body).toBe(budgetBody(3));
    expect(first.created()).toBe(1);
    expect(first.updated()).toBe(2);
  });

  test("ignores a lookalike marker written by another author", async () => {
    const state = harness();
    state.comments.push({
      id: 99,
      user: { id: 7, login: "human", type: "User" },
      body: budgetBody(3),
    });
    const decision = await admitReviewAttempt(options(state.fetch));
    expect(decision).toEqual({ admitted: true, reason: "admitted", count: 1 });
    expect(state.comments).toHaveLength(2);
  });

  test.each([
    ["marker only", { body: marker }],
    ["malformed json", { body: `${marker}\n{"review":"3"}` }],
    ["extra text", { body: `${marker}\nextra\n{"review":1}` }],
    ["negative", { body: `${marker}\n{"review":-1}` }],
  ])("fails closed on %s", async (_label, overrides) => {
    const state = harness();
    state.comments.push({
      id: 99,
      user: { id: githubActionsBotId, login: "github-actions[bot]", type: "Bot" },
      ...overrides,
    } as { id: number; user: { id: number; login: string; type: string }; body: string });
    await expect(admitReviewAttempt(options(state.fetch))).rejects.toThrow();
  });

  test("fails closed on duplicate matching counters", async () => {
    const state = harness([1, 1]);
    await expect(admitReviewAttempt(options(state.fetch))).rejects.toThrow();
  });

  test("does not spend an attempt when the pinned head moved", async () => {
    const state = harness([0], {
      head: { sha: "c".repeat(40), repo: { id: 1, full_name: repository } },
    });
    expect(await admitReviewAttempt(options(state.fetch))).toEqual({
      admitted: false,
      reason: "stale",
    });
    expect(state.created()).toBe(0);
    expect(state.updated()).toBe(0);
  });

  test("does not spend an attempt on a closed or draft PR", async () => {
    const closed = harness([0], { state: "closed" });
    expect(await admitReviewAttempt(options(closed.fetch))).toEqual({
      admitted: false,
      reason: "closed",
    });
    const draft = harness([0], { draft: true });
    expect(await admitReviewAttempt(options(draft.fetch))).toEqual({
      admitted: false,
      reason: "draft",
    });
  });

  test("fails closed when the PR cannot be read", async () => {
    await expect(
      admitReviewAttempt(
        options(async () => {
          throw new Error("unavailable");
        }),
      ),
    ).rejects.toThrow();
  });

  test("keeps the marker and state format documented by the workflow", () => {
    expect(marker).toBe("<!-- gh-aw-review-attempt-budget:v1 -->");
    expect(githubActionsBotId).toBe(41898282);
  });
});

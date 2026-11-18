import { describe, expect, test } from "vitest";
import {
  formatGhAwReviewBody,
  parseAgentReport,
  publishGhAwReview,
  type ReviewReport,
} from "./gh-aw-review-publish";

const sha = "a".repeat(40);
const repository = "ignateff/ai-for-developers-project-387";
const report: ReviewReport = {
  summary: "Подтверждённых дефектов не найдено.",
  findings: [
    {
      file: "apps/web/src/a.ts",
      line: 4,
      conditions: "Если дата пуста",
      consequence: "Пользователь видит неверное время",
    },
  ],
  limitations: ["Контекст CI неполон или недоступен."],
};

const commentHarness = (head = sha) => {
  const comments: { id: number; user: { id: number; login: string }; body: string }[] = [];
  let posts = 0;
  const apiFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/pulls/7"))
      return Response.json({
        number: 7,
        state: "open",
        head: { sha: head },
        base: { sha: "b".repeat(40), repo: { id: 1, full_name: repository } },
      });
    if (url.pathname.endsWith("/issues/7/comments") && init?.method === "POST") {
      posts++;
      const body = JSON.parse(String(init.body)).body as string;
      const comment = { id: comments.length + 1, user: { id: 42, login: "bot" }, body };
      comments.push(comment);
      return Response.json(comment, { status: 201 });
    }
    if (url.pathname.includes("/issues/7/comments")) return Response.json(comments);
    return new Response(null, { status: 404 });
  };
  return { fetch: apiFetch, comments, posts: () => posts };
};

const options = (apiFetch: typeof fetch, overrides: Record<string, unknown> = {}) => ({
  fetch: apiFetch,
  repository,
  token: "token",
  authorId: 42,
  number: 7,
  sha,
  runId: "1",
  runAttempt: "1",
  report,
  metaLimitations: ["Контекст связанных файлов репозитория ограничен."],
  staged: false,
  ...overrides,
});

describe("gh-aw review publication", () => {
  test("formats a Russian advisory report with the verified SHA, run link and limitations", () => {
    const body = formatGhAwReviewBody({
      repository,
      sha,
      runId: "1",
      report,
    });
    expect(body.split("\n")[0]).toMatch(
      new RegExp(`^<!-- gh-aw-review-report:${sha}:[a-f0-9]{16} -->$`),
    );
    expect(body).toContain("## Автоматическое ревью (gh-aw)");
    expect(body).toContain(`Проверенный head: \`${sha}\``);
    expect(body).toContain(`https://github.com/${repository}/actions/runs/1`);
    expect(body).toContain("Подтверждённых дефектов не найдено.");
    expect(body).toContain("apps/web/src/a.ts:4");
    expect(body).toContain("Контекст CI неполон");
    expect(body).toContain("не полное ревью кода");
  });

  test("publishes one general comment and deduplicates an identical report", async () => {
    const state = commentHarness();
    expect(await publishGhAwReview(options(state.fetch))).toBe("published");
    expect(state.comments).toHaveLength(1);
    expect(state.comments[0].body.split("\n")[0]).toMatch(
      new RegExp(`^<!-- gh-aw-review-report:${sha}:[a-f0-9]{16} -->$`),
    );
    expect(await publishGhAwReview(options(state.fetch))).toBe("already-published");
    expect(state.posts()).toBe(1);
  });

  test("publishes a different report for the same head", async () => {
    const state = commentHarness();
    expect(await publishGhAwReview(options(state.fetch))).toBe("published");
    expect(
      await publishGhAwReview(
        options(state.fetch, {
          report: { ...report, summary: "Другой вывод после полного повторного запуска." },
        }),
      ),
    ).toBe("published");
    expect(state.posts()).toBe(2);
  });

  test("does not publish a report whose pinned head moved", async () => {
    const state = commentHarness("c".repeat(40));
    await expect(publishGhAwReview(options(state.fetch))).rejects.toThrow(/head/i);
    expect(state.posts()).toBe(0);
  });

  test("shows a staged draft without writing a comment", async () => {
    const state = commentHarness();
    const body = await publishGhAwReview(options(state.fetch, { staged: true }));
    expect(body.split("\n")[0]).toMatch(
      new RegExp(`^<!-- gh-aw-review-report:${sha}:[a-f0-9]{16} -->$`),
    );
    expect(state.posts()).toBe(0);
    expect(state.comments).toHaveLength(0);
  });

  test("escapes HTML and mention-like text from model output", () => {
    const body = formatGhAwReviewBody({
      repository,
      sha,
      runId: "1",
      report: {
        summary: "<script>alert(1)</script> @maintainer",
        findings: [],
        limitations: [],
      },
    });
    expect(body).not.toContain("<script>");
    expect(body).toContain("&lt;script&gt;");
    expect(body).not.toContain("@maintainer");
  });

  test.each([
    ["empty summary", { ...report, summary: "" }],
    ["invalid line", { ...report, findings: [{ ...report.findings[0], line: 0 }] }],
    ["missing consequence", { ...report, findings: [{ ...report.findings[0], consequence: "" }] }],
    ["too many findings", { ...report, findings: Array(101).fill(report.findings[0]) }],
  ])("rejects a malformed report: %s", async (_label, malformed) => {
    const state = commentHarness();
    await expect(
      publishGhAwReview(options(state.fetch, { report: malformed as ReviewReport })),
    ).rejects.toThrow();
    expect(state.posts()).toBe(0);
  });

  test("reads exactly one report from the custom safe-output item", () => {
    expect(
      parseAgentReport({ items: [{ type: "publish_review", report: JSON.stringify(report) }] }),
    ).toEqual(report);
    expect(() => parseAgentReport({ items: [] })).toThrow();
    expect(() =>
      parseAgentReport({
        items: [
          { type: "publish_review", report: JSON.stringify(report) },
          { type: "publish_review", report: JSON.stringify(report) },
        ],
      }),
    ).toThrow();
    expect(() =>
      parseAgentReport({ items: [{ type: "publish_review", report: '{"summary":""}' }] }),
    ).toThrow();
  });
});

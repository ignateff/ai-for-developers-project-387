import { expect, test } from "vitest";
import { publishWorkflow } from "./opencode-review-publish-cli";
import { formatReviewBody, publishReview } from "./opencode-review-publish";

const sha = "a".repeat(40);
const env = {
  RUNNER_TEMP: "/tmp",
  GITHUB_REPOSITORY: "owner/repo",
  GH_TOKEN: "token",
  OPENCODE_PR_NUMBER: "7",
  OPENCODE_HEAD_SHA: sha,
  OPENCODE_REVIEW_ARTIFACT: "review-123-1",
};

test("oversize recovery rejects malformed finding structure before contacting GitHub", async () => {
  let calls = 0;
  await expect(
    publishWorkflow({
      fetch: async () => {
        calls++;
        return Response.json({});
      },
      authorId: 42,
      env,
      readReport: async () => ({
        summary: "Ревью",
        limitations: [],
        publicationLimit: true,
        findings: [
          { file: "booking.ts", line: 0, conditions: "x".repeat(12001), consequence: "дефект" },
        ],
      }),
    }),
  ).rejects.toThrow();
  expect(calls).toBe(0);
});

test("publication-only rerun publishes a saved Russian review without budget or model calls", async () => {
  const comments: string[] = [];
  const api: typeof fetch = async (input, init) => {
    if (String(input).includes("/pulls/")) return Response.json({ number: 7, head: { sha } });
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
      env,
      readReport: async () => ({
        summary: "Подтверждённых дефектов не найдено.",
        limitations: ["Требования недоступны: Связанные требования не удалось загрузить."],
        findings: [],
      }),
    });
  await publish();
  await publish();
  expect(comments).toHaveLength(1);
  expect(comments[0]).toContain("## Автоматическое ревью OpenCode");
  expect(comments[0]).toContain("Подтверждённых дефектов не найдено.");
  expect(comments[0]).toContain("не полное ревью кода");
  expect(comments[0]).toContain("Требования недоступны");
  expect(comments[0]).toContain(sha);
  expect(comments[0]).toContain("https://github.com/owner/repo/actions/runs/123/attempts/1");
});

test("publication with findings keeps paths and line numbers unchanged", () => {
  const body = formatReviewBody("owner/repo", sha, "review-1-1", {
    summary: "Найдены подтверждённые дефекты.",
    limitations: ["Двоичное содержимое не проверялось: image.png"],
    findings: [
      {
        file: "scripts/opencode-review.ts",
        line: 12,
        conditions: "Если слот уже занят",
        consequence: "Возможна двойная запись",
      },
    ],
  });
  expect(body).toContain("- Ограничение: Двоичное содержимое не проверялось: image.png");
  expect(body).toContain(
    "- scripts/opencode-review.ts:12 — Если слот уже занят; Возможна двойная запись",
  );
  expect(body).toContain("Ревью носит рекомендательный характер");
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
      env,
      readReport: async () => ({
        summary: "Подтверждённых дефектов не найдено.",
        limitations: [],
        findings: [],
      }),
    });
  await expect(publish()).rejects.toThrow();
  expect(posts).toBe(0);
});

test("clean review without context limitations keeps the advisory wording", () => {
  const body = formatReviewBody("owner/repo", sha, "review-1-1", {
    summary: "Подтверждённых дефектов не найдено.",
    limitations: [],
    findings: [],
  });
  expect(body).toContain("Ревью носит рекомендательный характер");
  expect(body).not.toContain("не полное ревью кода");
  expect(body).not.toContain("Ограничение:");
});

test("Russian incomplete context restores the visible non-full-review warning", () => {
  const body = formatReviewBody("owner/repo", sha, "review-1-1", {
    summary: "Подтверждённых дефектов не найдено.",
    limitations: ["Контекст связанных файлов репозитория недоступен: деревья не загрузились."],
    findings: [],
  });
  expect(body).toContain("не полное ревью кода");
});

test("a previously saved English artifact keeps the warning when republished", async () => {
  const comments: string[] = [];
  const api: typeof fetch = async (input, init) => {
    if (String(input).includes("/pulls/")) return Response.json({ number: 7, head: { sha } });
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
      env,
      readReport: async () => ({
        summary: "No confirmed defects",
        limitations: ["Related repository context is unavailable: trees failed."],
        findings: [],
      }),
    });
  await publish();
  await publish();
  expect(comments).toHaveLength(1);
  expect(comments[0]).toContain("не полное ревью кода");
  expect(comments[0]).toContain("Related repository context is unavailable");
});

test("a failed review publishes a Russian warning instead of a successful review", () => {
  const body = formatReviewBody("owner/repo", sha, "review-1-1", { failure: "timeout" });
  expect(body).toContain("Ревью остановлено: таймаут (timeout)");
  expect(body).toContain("Требуется вмешательство человека");
  expect(body).not.toMatch(/подтверждённых дефектов/i);
});

test("publication limit hides findings but keeps the artifact link", () => {
  const body = formatReviewBody("owner/repo", sha, "review-1-1", {
    summary: "Найдены подтверждённые дефекты.",
    limitations: [],
    findings: [{ file: "booking.ts", line: 1, conditions: "Условие", consequence: "Последствие" }],
    publicationLimit: true,
  });
  expect(body).toContain("находки не включены в этот комментарий");
  expect(body).toContain("лимит публикации");
  expect(body).toContain("`review-1-1`");
  expect(body).not.toContain("booking.ts:1");
});

test("an oversized body is rejected without discarding findings", async () => {
  const api: typeof fetch = async (input) => {
    if (String(input).includes("/pulls/7")) return Response.json({ number: 7, head: { sha } });
    return Response.json([]);
  };
  await expect(
    publishReview({
      fetch: api,
      repository: "owner/repo",
      token: "token",
      authorId: 42,
      number: 7,
      sha,
      artifact: "review-123-1",
      report: {
        summary: "Найдены подтверждённые дефекты.",
        limitations: [],
        findings: Array.from({ length: 6 }, (_, index) => ({
          file: "booking.ts",
          line: index + 1,
          conditions: "x".repeat(11000),
          consequence: "Подтверждённый дефект",
        })),
      },
    }),
  ).rejects.toThrow("Тело ревью превышает лимит публикации");
});

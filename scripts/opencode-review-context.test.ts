import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { reviewWorkflow } from "./opencode-review-workflow";

test("linked issue evidence is charged once and does not crowd out later evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "review-context-once-"));
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
          body: Array.from({ length: 9 }, (_, i) => `#${i + 1}`).join(" "),
          base: { sha: base, repo: { id: 1, full_name: "ignateff/ai-for-developers-project-387" } },
          head: { sha, repo: { id: 1, full_name: "ignateff/ai-for-developers-project-387" } },
        });
      if (path.endsWith("/pulls/7/files"))
        return Response.json([{ filename: "a", status: "added" }]);
      if (path.includes("/contents/"))
        return Response.json({ type: "file", encoding: "base64", content: "eA==", size: 1 });
      if (/\/issues\/\d+$/.test(path))
        return Response.json({ title: "spec", body: "x".repeat(25000) });
      if (path.endsWith("/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (path.endsWith("/status")) return Response.json({ state: "success", statuses: [] });
      if (path.endsWith("/reviews")) return Response.json([{ body: "later review evidence" }]);
      return Response.json([]);
    };
    let snapshot: any;
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
        review: async ({ context }) => {
          snapshot = context;
          return { summary: "ok", findings: [], limitations: [] };
        },
      },
    );
    expect(JSON.parse(snapshot.requirements.text).materials).toHaveLength(9);
    expect(snapshot.previousReview.reviews[0].body).toBe("later review evidence");
    expect(snapshot.limitations.join(" ")).not.toContain("суммарный лимит размера");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("documents stay unconfirmed and large optional evidence is bounded with explicit limitations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "review-context-budget-"));
  const sha = "a".repeat(40),
    base = "b".repeat(40),
    historical = "c".repeat(40);
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
          body: `Agreement: https://github.com/ignateff/ai-for-developers-project-387/blob/${base}/docs/approval%20notes.md\nhttps://github.com/ignateff/ai-for-developers-project-386/blob/${historical}/docs/history.md\nhttps://github.com/ignateff/ai-for-developers-project-386/blob/main/docs/history.md\nhttps://github.com/ignateff/ai-for-developers-project-386/blob/feature/docs/history.md\nhttps://github.com/ignateff/ai-for-developers-project-386/blob/${historical}/docs/%2e%2e/secret.md`,
          base: { sha: base, repo: { id: 1, full_name: "ignateff/ai-for-developers-project-387" } },
          head: { sha, repo: { id: 1, full_name: "ignateff/ai-for-developers-project-387" } },
        });
      if (path.endsWith("/pulls/7/files"))
        return Response.json([{ filename: "a", status: "added" }]);
      if (
        path.endsWith("/contents/docs/approval%20notes.md") ||
        path.endsWith("/contents/docs/history.md")
      ) {
        const content = "Explicit approval in document";
        return Response.json({
          type: "file",
          encoding: "base64",
          content: Buffer.from(content).toString("base64"),
          size: Buffer.byteLength(content),
        });
      }
      if (path.includes("/contents/"))
        return Response.json({ type: "file", encoding: "base64", content: "eA==", size: 1 });
      if (path.endsWith("/issues/33")) return Response.json({ title: "spec", body: "requirement" });
      if (path.endsWith("/commits/main")) return Response.json({ sha: historical });
      if (path.endsWith("/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (path.endsWith("/status")) return Response.json({ state: "success", statuses: [] });
      if (path.endsWith("/pulls/7/reviews"))
        return Response.json(Array(80).fill({ body: '\\"'.repeat(15000) }));
      return Response.json([]);
    };
    let snapshot: any;
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
        review: async ({ context }) => {
          snapshot = context;
          return { summary: "Подтверждённых дефектов не найдено.", findings: [], limitations: [] };
        },
      },
    );
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(4 * 1024 * 1024);
    expect(snapshot.requirements.availability).toBe("available");
    expect(snapshot.requirements.text).toContain("Explicit approval in document");
    expect(snapshot.agreement.sources).toContainEqual(
      expect.objectContaining({
        status: "unconfirmed",
        source: `https://github.com/ignateff/ai-for-developers-project-387/blob/${base}/docs/approval%20notes.md`,
        text: "Explicit approval in document",
        author: null,
        resolvedRef: base,
      }),
    );
    expect(snapshot.agreement.sources).toContainEqual(
      expect.objectContaining({
        source: `https://github.com/ignateff/ai-for-developers-project-386/blob/${historical}/docs/history.md`,
        text: "Explicit approval in document",
        resolvedRef: historical,
        status: "unconfirmed",
      }),
    );
    expect(snapshot.agreement.sources).toContainEqual(
      expect.objectContaining({
        source:
          "https://github.com/ignateff/ai-for-developers-project-386/blob/feature/docs/history.md",
        text: null,
        resolvedRef: null,
        status: "unconfirmed",
      }),
    );
    expect(snapshot.agreement.sources).toContainEqual(
      expect.objectContaining({
        source:
          "https://github.com/ignateff/ai-for-developers-project-386/blob/main/docs/history.md",
        resolvedRef: null,
        text: null,
        status: "unconfirmed",
      }),
    );
    expect(
      requested.some((url) => url.includes(`/contents/docs/approval%20notes.md?ref=${base}`)),
    ).toBe(true);
    expect(
      requested.some((url) => url.includes(`/contents/docs/history.md?ref=${historical}`)),
    ).toBe(true);
    expect(requested.filter((url) => url.includes("/contents/docs/history.md?")).length).toBe(1);
    expect(requested.some((url) => url.includes("approval%2520notes"))).toBe(false);
    expect(requested.some((url) => url.includes("/contents/docs/secret.md"))).toBe(false);
    expect(requested.some((url) => url.includes("/commits/main"))).toBe(false);
    const limitations = snapshot.limitations.join(" ");
    expect(limitations).toContain("суммарный лимит размера");
    expect(limitations).toContain("неоднознач");
    for (const criterion of [
      "владелец-человек",
      "write, maintain или admin",
      "неоднозначное «ok»",
      "Бот",
      "закрытие задачи",
      "ready-for-agent",
      "одни только права",
    ])
      expect(limitations).toContain(criterion);
    const report = JSON.parse(
      await readFile(join(dir, "opencode-review-1-1", "review.json"), "utf8"),
    );
    expect(report.limitations.join(" ")).toContain("суммарный лимит размера");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

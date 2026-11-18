import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { collectGhAwReviewContext } from "./gh-aw-review-context";

const sha = "a".repeat(40);
const base = "b".repeat(40);
const repository = "ignateff/ai-for-developers-project-387";
const changed = "apps/web/src/a.ts";
const testFile = "apps/web/src/a.test.ts";

const blob = (character: string) => character.repeat(40);
const treeBlob = (path: string, sha: string, size: number) => ({
  path,
  mode: "100644",
  type: "blob",
  sha,
  size,
});
const encoded = (text: string) => ({
  type: "file",
  encoding: "base64",
  content: Buffer.from(text).toString("base64"),
  size: Buffer.byteLength(text),
});

const pull = {
  number: 7,
  state: "open",
  draft: false,
  changed_files: 1,
  title: "Add availability",
  body: "Request: #33",
  user: { login: "owner", type: "User", id: 1 },
  base: { sha: base, repo: { id: 1, full_name: repository } },
  head: { sha, repo: { id: 1, full_name: repository } },
};

const sources: Record<string, string> = {
  [changed]: "export const availability = true;",
  [testFile]: 'import { availability } from "./a";\nexpect(availability).toBe(true);',
  "REVIEW.md": "Calendar review criteria",
  "AGENTS.md": "Project instructions",
  "README.md": "Readme",
  "docs/agents/project-history.md": "History",
};

const tree = (ref: string) => ({
  sha: ref,
  truncated: false,
  tree: [
    treeBlob(changed, ref === base ? blob("1") : blob("2"), 10),
    treeBlob(testFile, blob("3"), Buffer.byteLength(sources[testFile])),
    treeBlob("REVIEW.md", blob("4"), 10),
    treeBlob("AGENTS.md", blob("5"), 10),
    treeBlob("README.md", blob("6"), 10),
    treeBlob("docs/agents/project-history.md", blob("7"), 10),
  ],
});

const api = (
  options: { finalHead?: string; missingTree?: boolean; missingCi?: boolean } = {},
): typeof fetch => {
  return async (input) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path.endsWith("/pulls/7")) {
      if (options.finalHead && options.finalHead !== sha)
        return Response.json({
          ...pull,
          head: { ...pull.head, sha: options.finalHead },
        });
      return Response.json(pull);
    }
    if (path.endsWith("/pulls/7/files"))
      return Response.json([{ filename: changed, status: "modified", patch: "-old\n+new" }]);
    if (path.includes("/git/trees/")) {
      if (options.missingTree) return new Response(null, { status: 404 });
      return Response.json(tree(path.split("/git/trees/")[1]));
    }
    if (path.endsWith("/issues/33"))
      return Response.json({ title: "Requirements", body: "Booking requirements" });
    if (path.includes("/contents/")) {
      const name = decodeURIComponent(path.split("/contents/")[1]);
      const ref = url.searchParams.get("ref");
      const content =
        name === changed && ref === base
          ? "export const availability = false;"
          : (sources[name] ?? "base document");
      return Response.json(encoded(content));
    }
    if (path.endsWith("/check-runs")) {
      if (options.missingCi) return new Response(null, { status: 404 });
      return Response.json({
        total_count: 1,
        check_runs: [
          {
            name: "CI",
            status: "completed",
            conclusion: "success",
            html_url: "https://example.com/check",
          },
        ],
      });
    }
    if (path.endsWith("/status")) return Response.json({ state: "success", statuses: [] });
    if (path.endsWith("/pulls/7/reviews"))
      return Response.json([
        { body: "Earlier finding", user: { login: "reviewer" }, state: "COMMENTED" },
      ]);
    if (path.endsWith("/pulls/7/comments"))
      return Response.json([
        {
          body: "old finding",
          path: changed,
          line: 12,
          original_line: 9,
          side: "RIGHT",
          commit_id: blob("8"),
          diff_hunk: "@@ -1 +1 @@",
        },
      ]);
    if (path.endsWith("/issues/7/comments")) return Response.json([]);
    if (path.endsWith("/pulls/7/commits"))
      return Response.json([
        {
          sha: blob("9"),
          commit: { message: "feat: add availability" },
          author: { login: "owner" },
        },
      ]);
    return new Response(null, { status: 404 });
  };
};

const collect = (apiFetch: typeof fetch, outputDirectory: string) =>
  collectGhAwReviewContext({
    fetch: apiFetch,
    repository,
    token: "token",
    number: 7,
    expectedHeadSha: sha,
    runId: "1",
    runAttempt: "1",
    outputDirectory,
  });

describe("gh-aw pinned review context", () => {
  test("writes the trusted base criteria, changed sources, related files and evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gh-aw-context-"));
    try {
      const { snapshot, meta } = await collect(api(), directory);

      expect(snapshot).toMatchObject({
        schema: "gh-aw-review/v1",
        baseSha: base,
        headSha: sha,
        pullRequest: { number: 7, title: "Add availability" },
        criteria: { path: "REVIEW.md", available: true, content: "Calendar review criteria" },
      });
      expect(snapshot.changes[0]).toMatchObject({
        filename: changed,
        status: "modified",
        patch: "-old\n+new",
        data: {
          base: `data/changed/base/${changed}`,
          head: `data/changed/head/${changed}`,
        },
      });
      expect(JSON.stringify(snapshot.changes[0])).not.toContain("availability = true");
      expect(
        snapshot.repository.related.some((file: { path: string }) => file.path === testFile),
      ).toBe(true);
      expect(snapshot.requirements.materials[0].body).toContain("Booking requirements");
      expect(snapshot.ci).toMatchObject({ headSha: sha, status: "success" });
      expect(snapshot.ci.checks[0]).toMatchObject({ name: "CI", conclusion: "success" });
      expect(snapshot.previousReview.reviews[0].body).toBe("Earlier finding");
      expect(snapshot.previousReview.reviewComments[0]).toMatchObject({
        path: changed,
        line: 12,
        originalLine: 9,
      });
      expect(snapshot.commits[0]).toMatchObject({
        sha: blob("9"),
        message: "feat: add availability",
      });
      expect(meta).toMatchObject({
        schema: "gh-aw-review-meta/v1",
        number: 7,
        baseSha: base,
        headSha: sha,
        runId: "1",
        runAttempt: "1",
        artifact: "review-1-1",
      });

      const written = JSON.parse(await readFile(join(directory, "snapshot.json"), "utf8"));
      expect(written.headSha).toBe(sha);
      expect(await readFile(join(directory, "data", "changed", "head", changed), "utf8")).toContain(
        "availability = true",
      );
      expect(await readFile(join(directory, "data", "changed", "base", changed), "utf8")).toContain(
        "availability = false",
      );
      expect(await readFile(join(directory, "data", "repository", testFile), "utf8")).toContain(
        "expect(availability)",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("records unavailable or incomplete evidence as explicit limitations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gh-aw-context-limited-"));
    try {
      const { snapshot } = await collect(api({ missingTree: true, missingCi: true }), directory);
      expect(snapshot.repository).toMatchObject({ available: false, related: [] });
      expect(snapshot.limitations.join(" ")).toContain(
        "Контекст связанных файлов репозитория недоступен",
      );
      expect(snapshot.limitations.join(" ")).toContain("Контекст CI неполон или недоступен");
      expect(
        JSON.parse(await readFile(join(directory, "snapshot.json"), "utf8")).limitations,
      ).toEqual(snapshot.limitations);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("fails closed when the live head moved during collection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gh-aw-context-moved-"));
    try {
      await expect(collect(api({ finalHead: "c".repeat(40) }), directory)).rejects.toThrow(
        /head|SHA/i,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

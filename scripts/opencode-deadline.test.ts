import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { runBudgetCli } from "./opencode-budget-cli.ts";
import { createReviewAdapter, runReviewProcess } from "./opencode-review.ts";
import { ReviewFailure } from "./opencode-review-failure.ts";

it.each(["timeout", "pre-model", "cancelled"] as const)(
  "classifies %s at the CLI boundary",
  async (scenario) => {
    const dir = await mkdtemp(join(tmpdir(), "deadline-model-"));
    const sha = "a".repeat(40);
    const comments: any[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/pulls/7"))
        return Response.json({
          number: 7,
          state: "open",
          draft: false,
          changed_files: 1,
          body: "",
          user: { type: "User", login: "owner" },
          base: { sha: "b".repeat(40), repo: { id: 1, full_name: "owner/repo" } },
          head: { sha, repo: { id: 1, full_name: "owner/repo" } },
        });
      if (path.endsWith("/pulls/7/files"))
        return Response.json([{ filename: "x", status: "added" }]);
      if (path.includes("/contents/"))
        return Response.json({ type: "file", encoding: "base64", content: "eA==", size: 1 });
      if (init?.method === "POST") {
        const item = { id: 1, user: { id: 42 }, body: JSON.parse(String(init.body)).body };
        comments.push(item);
        return Response.json(item);
      }
      if (init?.method === "PATCH") {
        comments[0].body = JSON.parse(String(init.body)).body;
        return Response.json(comments[0]);
      }
      return Response.json(comments);
    };
    const event = join(dir, "event.json");
    try {
      await writeFile(
        event,
        JSON.stringify({
          action: "opened",
          repository: { full_name: "owner/repo" },
          pull_request: { number: 7 },
        }),
      );
      vi.useFakeTimers();
      let launched = false;
      const review = createReviewAdapter({
        verify: async () => {},
        run: async (_binary, args, options) => {
          if (args[0] === "debug") {
            if (scenario === "pre-model") vi.advanceTimersByTime(12 * 60_000);
            const config = JSON.parse(options.env.OPENCODE_CONFIG_CONTENT!);
            return JSON.stringify({
              name: "reviewer",
              permission: Object.entries(config.permission).map(([permission, action]) => ({
                permission,
                action,
                pattern: "*",
              })),
            });
          }
          launched = true;
          if (scenario === "cancelled") throw new ReviewFailure("cancelled");
          vi.advanceTimersByTime(12 * 60_000);
          return new Promise((_resolve, reject) => {
            if (options.signal?.aborted) reject(new Error("aborted"));
            else
              options.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
                once: true,
              });
          });
        },
      });
      const result = await runBudgetCli({
        kind: "review",
        authorId: 42,
        fetch,
        review,
        env: {
          RUNNER_TEMP: dir,
          GITHUB_EVENT_PATH: event,
          GITHUB_OUTPUT: join(dir, "output"),
          GITHUB_EVENT_NAME: "pull_request",
          GITHUB_REPOSITORY: "owner/repo",
          GITHUB_REPOSITORY_OWNER: "owner",
          GITHUB_RUN_ID: "1",
          GITHUB_RUN_ATTEMPT: "1",
          GH_TOKEN: "token",
          DEEPSEEK_API_KEY: "key",
          OPENCODE_REVIEW_STARTED_AT: String(Date.now()),
        },
        prepare: async () => {
          await mkdir(join(dir, "opencode-review-1-1"));
          await writeFile(join(dir, "opencode-review-1-1", "binary"), "/fixture");
        },
      });
      expect(launched).toBe(scenario !== "pre-model");
      const expected = scenario === "pre-model" ? "infra" : scenario;
      expect(result.status).toBe(expected);
      const artifact = join(dir, "opencode-review-1-1", "review.json");
      if (scenario === "cancelled") {
        await expect(access(artifact)).rejects.toThrow();
        expect(await readFile(join(dir, "output"), "utf8")).toContain("report=false");
      } else expect(JSON.parse(await readFile(artifact, "utf8"))).toEqual({ failure: expected });
    } finally {
      vi.useRealTimers();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it("deadline kills active preparation descendants and produces an independently publishable failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "deadline-cli-"));
  const sha = "a".repeat(40);
  const comments: { id: number; user: { id: number }; body: string }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/pulls/7"))
      return Response.json({
        number: 7,
        state: "open",
        draft: false,
        user: { type: "User", login: "owner" },
        base: { repo: { id: 1, full_name: "owner/repo" } },
        head: { sha, repo: { id: 1, full_name: "owner/repo" } },
      });
    if (init?.method === "POST") {
      const item = { id: 1, user: { id: 42 }, body: JSON.parse(String(init.body)).body };
      comments.push(item);
      return Response.json(item);
    }
    if (init?.method === "PATCH") {
      comments[0].body = JSON.parse(String(init.body)).body;
      return Response.json(comments[0]);
    }
    return Response.json(comments);
  };
  const event = join(dir, "event.json");
  const marker = join(dir, "survived");
  try {
    await writeFile(
      event,
      JSON.stringify({
        action: "opened",
        repository: { full_name: "owner/repo" },
        pull_request: { number: 7 },
      }),
    );
    let modelCalls = 0;
    const result = await runBudgetCli({
      kind: "review",
      authorId: 42,
      fetch,
      env: {
        RUNNER_TEMP: dir,
        GITHUB_EVENT_PATH: event,
        GITHUB_OUTPUT: join(dir, "output"),
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_REPOSITORY: "owner/repo",
        GITHUB_REPOSITORY_OWNER: "owner",
        GITHUB_RUN_ID: "1",
        GITHUB_RUN_ATTEMPT: "1",
        GH_TOKEN: "token",
        DEEPSEEK_API_KEY: "key",
        OPENCODE_REVIEW_STARTED_AT: String(Date.now() - 12 * 60_000 + 400),
      },
      prepare: async (signal) => {
        await runReviewProcess(
          "/bin/sh",
          ["-c", '(sleep 1; touch "$1") & wait', "fixture", marker],
          { cwd: dir, env: { PATH: "/usr/bin:/bin" }, signal },
        );
      },
      model: async () => {
        modelCalls++;
      },
    });
    expect(result.status).toBe("infra");
    expect(modelCalls).toBe(0);
    expect(
      JSON.parse(await readFile(join(dir, "opencode-review-1-1", "review.json"), "utf8")),
    ).toEqual({ failure: "infra" });
    expect(await readFile(join(dir, "output"), "utf8")).toContain("report=true");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await expect(access(marker)).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 5000);

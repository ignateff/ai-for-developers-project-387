import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runBudgetCli } from "./opencode-budget-cli.ts";
import { runReviewProcess } from "./opencode-review.ts";

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

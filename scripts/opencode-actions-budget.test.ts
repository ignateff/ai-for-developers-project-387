import { expect, test } from "vitest";
import { countAdmissions, CUTOVER_RUN_ID } from "./opencode-actions-budget";

const current = CUTOVER_RUN_ID + 10;
const opts = { repository: "owner/repo", token: "token", pr: 7, runId: current, attempt: 2 };
function api(
  steps: unknown[] | null = [
    { name: "Record command admission v2", status: "completed", conclusion: "success" },
  ],
): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (url.includes("/workflows/"))
      return Response.json({
        workflow_runs: [
          { id: current, run_attempt: 2, event: "issue_comment", status: "in_progress" },
          {
            id: CUTOVER_RUN_ID + 1,
            run_attempt: 1,
            event: "pull_request_review_comment",
            status: "completed",
          },
          { id: CUTOVER_RUN_ID, run_attempt: 9, event: "issue_comment", status: "completed" },
        ],
      });
    return Response.json({
      total_count: 1,
      jobs: [{ name: "opencode-command-v2-pr-7", status: "completed", steps }],
    });
  };
}
test("counts prior attempts in both channels including previous reruns and ignores old runs", async () => {
  expect(await countAdmissions({ ...opts, fetch: api() })).toBe(2);
});
test("does not count skipped admission", async () => {
  expect(
    await countAdmissions({
      ...opts,
      fetch: api([
        { name: "Record command admission v2", status: "completed", conclusion: "skipped" },
      ]),
    }),
  ).toBe(0);
});
test.each([null, []])("fails closed when attempt steps are unavailable", async (steps) => {
  await expect(countAdmissions({ ...opts, fetch: api(steps) })).rejects.toThrow();
});
test("rejects old workflow reruns and missing current history", async () => {
  await expect(countAdmissions({ ...opts, runId: CUTOVER_RUN_ID, fetch: api() })).rejects.toThrow();
  await expect(
    countAdmissions({ ...opts, fetch: async () => Response.json({ workflow_runs: [] }) }),
  ).rejects.toThrow();
});

test("three admitted attempts are visible to the admission gate", async () => {
  const requests: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("/workflows/"))
      return Response.json({
        workflow_runs: [
          { id: current, run_attempt: 4, event: "issue_comment", status: "in_progress" },
        ],
      });
    return Response.json({
      total_count: 1,
      jobs: [
        {
          name: "opencode-command-v2-pr-7",
          status: "completed",
          steps: [
            { name: "Record command admission v2", status: "completed", conclusion: "success" },
          ],
        },
      ],
    });
  };
  expect(await countAdmissions({ ...opts, attempt: 4, fetch: fetcher })).toBe(3);
  expect(requests.filter((url) => url.includes("/attempts/"))).toHaveLength(3);
});

test("denies a fourth trusted command before runtime", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { admission } = await import("./opencode-actions-budget");
  const dir = await mkdtemp(join(tmpdir(), "actions-budget-"));
  const eventPath = join(dir, "event.json");
  try {
    await writeFile(
      eventPath,
      JSON.stringify({
        action: "created",
        repository: { full_name: "owner/repo", owner: { login: "owner" } },
        comment: { body: "/oc fix", user: { login: "owner", type: "User" } },
        issue: { number: 7, pull_request: {} },
      }),
    );
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/pulls/7"))
        return Response.json({
          number: 7,
          state: "open",
          base: { repo: { id: 1, full_name: "owner/repo" } },
          head: { repo: { id: 1, full_name: "owner/repo" }, sha: "a".repeat(40) },
        });
      if (url.includes("/workflows/"))
        return Response.json({
          workflow_runs: [
            { id: current, run_attempt: 4, event: "issue_comment", status: "in_progress" },
          ],
        });
      return Response.json({
        total_count: 1,
        jobs: [
          {
            name: "opencode-command-v2-pr-7",
            status: "completed",
            steps: [
              { name: "Record command admission v2", status: "completed", conclusion: "success" },
            ],
          },
        ],
      });
    };
    expect(
      await admission(
        {
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_EVENT_NAME: "issue_comment",
          GITHUB_REPOSITORY: "owner/repo",
          GITHUB_REPOSITORY_OWNER: "owner",
          GH_TOKEN: "token",
          GITHUB_RUN_ID: String(current),
          GITHUB_RUN_ATTEMPT: "4",
        },
        fetcher,
      ),
    ).toEqual({ status: "limit_exhausted", pr: 7, sha: "a".repeat(40) });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("counts a cancelled job when admission succeeded before cancellation", async () => {
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/workflows/"))
      return Response.json({
        workflow_runs: [
          { id: current, run_attempt: 1, event: "issue_comment", status: "in_progress" },
          {
            id: CUTOVER_RUN_ID + 1,
            run_attempt: 1,
            event: "pull_request_review_comment",
            status: "completed",
          },
        ],
      });
    return Response.json({
      total_count: 1,
      jobs: [
        {
          name: "opencode-command-v2-pr-7",
          status: "completed",
          conclusion: "cancelled",
          steps: [
            { name: "Record command admission v2", status: "completed", conclusion: "success" },
          ],
        },
      ],
    });
  };
  expect(await countAdmissions({ ...opts, attempt: 1, fetch: fetcher })).toBe(1);
});

test("fails closed if the current attempt has not appeared in Actions history", async () => {
  const fetcher: typeof fetch = async () =>
    Response.json({
      workflow_runs: [
        { id: current, run_attempt: 1, event: "issue_comment", status: "in_progress" },
      ],
    });
  await expect(countAdmissions({ ...opts, attempt: 2, fetch: fetcher })).rejects.toThrow(
    "current attempt not visible",
  );
});

test("retains the trusted PR identity when the later head lookup fails", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { admission } = await import("./opencode-actions-budget");
  const dir = await mkdtemp(join(tmpdir(), "actions-budget-head-"));
  const eventPath = join(dir, "event.json");
  let requests = 0;
  try {
    await writeFile(
      eventPath,
      JSON.stringify({
        action: "created",
        repository: { full_name: "owner/repo", owner: { login: "owner" } },
        comment: { body: "/oc fix", user: { login: "owner", type: "User" } },
        issue: { number: 7, pull_request: {} },
      }),
    );
    const fetcher: typeof fetch = async () => {
      requests++;
      if (requests === 1)
        return Response.json({
          number: 7,
          base: { repo: { id: 1, full_name: "owner/repo" } },
          head: { repo: { id: 1, full_name: "owner/repo" } },
        });
      throw new Error("network unavailable");
    };
    expect(
      await admission(
        {
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_EVENT_NAME: "issue_comment",
          GITHUB_REPOSITORY: "owner/repo",
          GITHUB_REPOSITORY_OWNER: "owner",
          GH_TOKEN: "token",
          GITHUB_RUN_ID: String(current),
          GITHUB_RUN_ATTEMPT: "1",
        },
        fetcher,
      ),
    ).toEqual({ status: "infra", pr: 7, sha: "unavailable" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

import { expect, it, vi } from "vitest";
import { createReviewAdapter, type ReviewContext } from "./opencode-review.ts";

const context: ReviewContext = {
  requirements: { availability: "available", text: "Booking works" },
  agreement: null,
  baseSha: "base",
  headSha: "head",
  changes: "example",
  ci: null,
  previousReview: null,
  isRelease: false,
};
const readEvent = (filePath = "snapshot-0001.jsonl", snapshot: ReviewContext = context) =>
  JSON.stringify({
    type: "tool_use",
    part: {
      tool: "read",
      state: {
        status: "completed",
        input: { filePath },
        output: `<content>\n${(JSON.stringify(snapshot).match(/[\s\S]{1,300}/gu) ?? []).map((s, i) => `${i + 1}: ${JSON.stringify(s)}`).join("\n")}\n</content>`,
      },
    },
  }) + '\n{"type":"step_finish","part":{"reason":"tool-calls"}}\n';

const validResult =
  JSON.stringify({
    type: "text",
    part: { text: JSON.stringify({ summary: "No defects found", limitations: [], findings: [] }) },
  }) + '\n{"type":"step_finish","part":{"reason":"stop"}}';
const policyOr = (output: string) =>
  vi.fn(async (_binary, args, options) => {
    if (args[0] !== "debug") return output;
    const config = JSON.parse(options.env.OPENCODE_CONFIG_CONTENT!);
    return JSON.stringify({
      name: "reviewer",
      permission: Object.entries(config.permission).map(([permission, action]) => ({
        permission,
        action,
        pattern: "*",
      })),
    });
  });

it.each([
  [
    "failed read",
    JSON.stringify({
      type: "tool_use",
      part: {
        tool: "read",
        state: { status: "error", input: { filePath: "snapshot.json" }, error: "failed" },
      },
    }) +
      "\n" +
      validResult,
  ],
  ["different file", readEvent("other.json") + validResult],
  [
    "malformed tool state",
    JSON.stringify({
      type: "tool_use",
      part: { tool: "read", state: { status: "completed", input: { filePath: "snapshot.json" } } },
    }) +
      "\n" +
      validResult,
  ],
  ["stop is not terminal", readEvent() + validResult + '\n{"type":"text","part":{"text":"extra"}}'],
])("rejects %s", async (_case, output) => {
  await expect(
    createReviewAdapter({ verify: async () => {}, run: policyOr(output) })({
      binary: "/runtime",
      context,
    }),
  ).rejects.toThrow("no review was produced");
});

it("reports explicitly unavailable requirements even for a release review", async () => {
  const review = createReviewAdapter({
    verify: async () => {},
    run: policyOr(
      readEvent("snapshot-0001.jsonl", {
        ...context,
        isRelease: true,
        requirements: { availability: "unavailable", reason: "not supplied" },
      }) + validResult,
    ),
  });
  const result = await review({
    binary: "/runtime",
    context: {
      ...context,
      isRelease: true,
      requirements: { availability: "unavailable", reason: "not supplied" },
    },
  });
  expect(result.limitations).toContain("Requirements unavailable: not supplied");
});

it("rejects a review when the CLI never reads the snapshot", async () => {
  const run = vi.fn(async (_binary, args, options) => {
    if (args[0] === "debug") {
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
    return '{"type":"text","part":{"text":"{\\"summary\\":\\"No defects found\\",\\"limitations\\":[],\\"findings\\":[]}"}}\n{"type":"step_finish","part":{"reason":"stop"}}';
  });
  await expect(
    createReviewAdapter({ verify: async () => {}, run })({ binary: "/runtime", context }),
  ).rejects.toThrow("no review was produced");
});

it("requires every exact line across multiple bounded snapshot files", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const large = { ...context, changes: `${'😀\\"'.repeat(5000)}END_MARKER` };
  let omitLast = false;
  const run = vi.fn(async (_binary, args, options) => {
    if (args[0] === "debug") return policyOr("")(_binary, args, options);
    const names = (await readdir(options.cwd)).filter((name) => name.endsWith(".jsonl")).sort();
    expect(names.length).toBeGreaterThan(1);
    const events = await Promise.all(
      names.map(async (filePath) => {
        const lines = (await readFile(`${options.cwd}/${filePath}`, "utf8")).split("\n");
        expect(lines.length).toBeLessThanOrEqual(30);
        expect(Math.max(...lines.map((line) => line.length))).toBeLessThan(2000);
        expect(Buffer.byteLength(lines.join("\n"))).toBeLessThan(40000);
        if (omitLast && filePath === names.at(-1)) lines.pop();
        return JSON.stringify({
          type: "tool_use",
          part: {
            tool: "read",
            state: {
              status: "completed",
              input: { filePath },
              output: `<content>\n${lines.map((line, index) => `${index + 1}: ${line}`).join("\n")}\n</content>`,
            },
          },
        });
      }),
    );
    return events.join("\n") + "\n" + validResult;
  });
  const review = createReviewAdapter({ verify: async () => {}, run });
  await expect(review({ binary: "/runtime", context: large })).resolves.toMatchObject({
    summary: "No defects found",
  });
  omitLast = true;
  await expect(review({ binary: "/runtime", context: large })).rejects.toThrow(
    "no review was produced",
  );
});

it("returns a structured review from a fresh isolated CLI session", async () => {
  const calls: { args: string[]; cwd: string }[] = [];
  const run = vi.fn(async (_binary, args, options) => {
    calls.push({ args, cwd: options.cwd });
    if (args[0] === "debug") {
      const config = JSON.parse(options.env.OPENCODE_CONFIG_CONTENT!);
      const permission = Object.entries(config.permission).map(([permission, action]) => ({
        permission,
        action,
        pattern: "*",
      }));
      return JSON.stringify({ name: "reviewer", permission });
    }
    return (
      readEvent() +
      JSON.stringify({
        type: "text",
        part: {
          text: JSON.stringify({ findings: [], summary: "No defects found", limitations: [] }),
        },
      }) +
      '\n{"type":"step_finish","part":{"reason":"stop"}}'
    );
  });
  const review = createReviewAdapter({ verify: async () => {}, run });
  const result = await review({ binary: "/trusted/opencode", context });
  expect(result.summary).toBe("No defects found");
  expect(result.limitations).toEqual([]);
  expect(calls.map((call) => call.args[0])).toEqual(["debug", "run"]);
  expect(calls[0].cwd).toBe(calls[1].cwd);
  expect(calls[1].args).toContain("reviewer");
});

it("fails closed on changed effective policy without running the model", async () => {
  const run = vi.fn(async () =>
    JSON.stringify({
      name: "reviewer",
      permission: [
        { permission: "*", pattern: "*", action: "deny" },
        { permission: "bash", pattern: "*", action: "allow" },
      ],
    }),
  );
  const review = createReviewAdapter({ verify: async () => {}, run });
  await expect(review({ binary: "/runtime", context })).rejects.toThrow("no review was produced");
  expect(run).toHaveBeenCalledTimes(1);
});

it.each([
  "",
  "not json",
  '{"type":"error","error":"secret"}',
  '{"type":"text","part":{"text":"{}"}}',
])("rejects invalid or failed CLI output without exposing it", async (output) => {
  const run = vi.fn(async (_binary, args, options) => {
    if (args[0] !== "debug") return output;
    const config = JSON.parse(options.env.OPENCODE_CONFIG_CONTENT!);
    return JSON.stringify({
      name: "reviewer",
      permission: Object.entries(config.permission).map(([permission, action]) => ({
        permission,
        pattern: "*",
        action,
      })),
    });
  });
  const failure = createReviewAdapter({ verify: async () => {}, run })({
    binary: "/runtime",
    context,
  });
  await expect(failure).rejects.toThrow("no review was produced");
  await expect(failure).rejects.not.toThrow("secret");
});

it("does not expose verification and process errors, and respects cancellation", async () => {
  const run = vi.fn(async () => {
    throw new Error("secret");
  });
  const review = createReviewAdapter({
    verify: async () => {
      throw new Error("secret");
    },
    run,
  });
  await expect(review({ binary: "/runtime", context })).rejects.toThrow("no review was produced");
  expect(run).not.toHaveBeenCalled();
  const controller = new AbortController();
  controller.abort();
  await expect(review({ binary: "/runtime", context, signal: controller.signal })).rejects.toThrow(
    "cancelled",
  );
});

it("uses a new empty workspace, excludes ambient credentials, and keeps snapshot data out of configuration", async () => {
  const workspaces: string[] = [];
  const { readdir, readFile } = await import("node:fs/promises");
  const run = vi.fn(async (_binary, args, options) => {
    if (args[0] === "debug") {
      workspaces.push(options.cwd);
      expect(await readdir(options.cwd)).toEqual([]);
      expect(options.env.GITHUB_TOKEN).toBeUndefined();
      expect(options.env.DEEPSEEK_API_KEY).toBeUndefined();
      expect(options.env.OPENCODE_CONFIG_CONTENT).not.toContain("hostile-config");
      const config = JSON.parse(options.env.OPENCODE_CONFIG_CONTENT!);
      return JSON.stringify({
        name: "reviewer",
        permission: Object.entries(config.permission).map(([permission, action]) => ({
          permission,
          pattern: "*",
          action,
        })),
      });
    }
    expect(options.env.DEEPSEEK_API_KEY).toBe("provider-key");
    expect(args.at(-1)).not.toContain("hostile-config");
    expect(await readFile(`${options.cwd}/snapshot-0001.jsonl`, "utf8")).toContain(
      "hostile-config",
    );
    return (
      readEvent("snapshot-0001.jsonl", { ...context, changes: "hostile-config" }) +
      JSON.stringify({
        type: "text",
        part: { text: '{"summary":"No defects found","limitations":[],"findings":[]}' },
      }) +
      '\n{"type":"step_finish","part":{"reason":"stop"}}'
    );
  });
  const review = createReviewAdapter({ verify: async () => {}, run });
  await review({
    binary: "/runtime",
    context: { ...context, changes: "hostile-config" },
    apiKey: "provider-key",
  });
  await review({
    binary: "/runtime",
    context: { ...context, changes: "hostile-config" },
    apiKey: "provider-key",
  });
  expect(workspaces[0]).not.toBe(workspaces[1]);
});

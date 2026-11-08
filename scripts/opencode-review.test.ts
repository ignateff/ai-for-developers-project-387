import { expect, it, vi } from "vitest";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReviewAdapter, runReviewProcess, type ReviewContext } from "./opencode-review.ts";
import { ReviewFailure } from "./opencode-review-failure.ts";

const context: ReviewContext = {
  requirements: { availability: "available", text: "Booking works" },
  agreement: null,
  limitations: [],
  baseSha: "base",
  headSha: "head",
  changes: "example",
  repository: {
    baseSha: "base",
    headSha: "head",
    available: true,
    index: null,
    related: [],
    limitations: [],
  },
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

it("aborts the reviewer and its child processes without waiting for inherited pipes", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-abort-"));
  const marker = join(root, "child-survived");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 250);
  try {
    await expect(
      runReviewProcess("/bin/sh", ["-c", '(sleep 1; touch "$1") & wait', "fixture", marker], {
        cwd: tmpdir(),
        env: { PATH: "/usr/bin:/bin" },
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ reason: "cancelled" });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await expect(access(marker)).rejects.toThrow();
  } finally {
    clearTimeout(timer);
    await rm(root, { recursive: true, force: true });
  }
}, 5000);

it("propagates deadline cancellation through verification and policy inspection", async () => {
  const controller = new AbortController();
  const verify = vi.fn(async (_binary: string, signal?: AbortSignal) => {
    expect(signal).toBe(controller.signal);
  });
  const run = vi.fn(async (_binary, args, options) => {
    expect(args[0]).toBe("debug");
    expect(options.signal).toBe(controller.signal);
    return runReviewProcess("/bin/sh", ["-c", "sleep 30"], options);
  });
  const timer = setTimeout(() => controller.abort(), 250);
  try {
    await expect(
      createReviewAdapter({ verify, run })({
        binary: "/fixture",
        context,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ reason: "cancelled" });
    expect(verify).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
  } finally {
    clearTimeout(timer);
  }
}, 5000);

it("does not launch a model when policy inspection leaves less than five minutes", async () => {
  const deadline = Date.now() + 301_000;
  const now = vi.spyOn(Date, "now");
  const policy = policyOr("");
  const run = vi.fn(async (binary, args, options) => {
    const result = await policy(binary, args, options);
    now.mockReturnValue(deadline - 300_000);
    return result;
  });
  try {
    const error = await createReviewAdapter({ verify: async () => {}, run })({
      binary: "/runtime",
      context,
      deadline,
    }).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(ReviewFailure);
    expect(run.mock.calls.map((call) => call[1][0])).toEqual(["debug"]);
  } finally {
    now.mockRestore();
  }
});

it("does not classify a policy inspection timeout as a model timeout", async () => {
  const error = await createReviewAdapter({
    verify: async () => {},
    run: async () => {
      throw new ReviewFailure("timeout");
    },
  })({ binary: "/runtime", context }).catch((e: unknown) => e);
  expect(error).not.toBeInstanceOf(ReviewFailure);
});

it("treats a missing executable after policy inspection as infrastructure failure", async () => {
  const policy = policyOr("");
  const review = createReviewAdapter({
    verify: async () => {},
    run: (binary, args, options) =>
      args[0] === "debug" ? policy(binary, args, options) : runReviewProcess(binary, args, options),
  });
  const error = await review({ binary: "/nonexistent-opencode-review-binary", context }).catch(
    (e: unknown) => e,
  );
  expect(error).not.toBeInstanceOf(ReviewFailure);
  expect(String(error)).not.toContain("ENOENT");
});

it("treats a non-executable runtime as infrastructure failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-no-execute-"));
  try {
    const binary = join(root, "runtime");
    await writeFile(binary, "#!/bin/sh\nexit 1\n", { mode: 0o600 });
    const policy = policyOr("");
    const review = createReviewAdapter({
      verify: async () => {},
      run: (path, args, options) =>
        args[0] === "debug" ? policy(path, args, options) : runReviewProcess(path, args, options),
    });
    const error = await review({ binary, context }).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(ReviewFailure);
    expect(String(error)).not.toContain("EACCES");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each(["timeout", "agent_failed", "cancelled"] as const)(
  "preserves %s if cleanup also fails",
  async (reason) => {
    const policy = policyOr("");
    const review = createReviewAdapter({
      verify: async () => {},
      run: async (binary, args, options) => {
        if (args[0] === "debug") return policy(binary, args, options);
        throw new ReviewFailure(reason);
      },
      cleanup: async (root) => {
        await rm(root, { recursive: true, force: true });
        throw new Error("secret cleanup detail");
      },
    });
    await expect(review({ binary: "/runtime", context })).rejects.toMatchObject({ reason });
  },
);

it("reports explicitly when there are no confirmed defects", async () => {
  const output =
    readEvent() +
    JSON.stringify({
      type: "text",
      part: { text: '{"summary":"Review completed","limitations":[],"findings":[]}' },
    }) +
    '\n{"type":"step_finish","part":{"reason":"stop"}}';
  const result = await createReviewAdapter({ verify: async () => {}, run: policyOr(output) })({
    binary: "/runtime",
    context,
  });
  expect(result.summary).toMatch(/no confirmed defects/i);
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
  [
    "review emitted before reading context",
    validResult.split('\n{"type":"step_finish"')[0] +
      "\n" +
      readEvent() +
      '{"type":"step_finish","part":{"reason":"stop"}}',
  ],
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

it("materializes pinned related repository files into a searchable workspace", async () => {
  const { readFile: read } = await import("node:fs/promises");
  const content = "export const formatTime = 1;";
  const related = {
    path: "apps/web/src/shared/format.ts",
    sha: "c".repeat(40),
    size: Buffer.byteLength(content),
    reason: "Imported by changed file",
    content,
  };
  const reviewContext: ReviewContext = {
    ...context,
    repository: {
      baseSha: "b".repeat(40),
      headSha: "a".repeat(40),
      available: true,
      index: { base: [related], head: [related] },
      related: [related],
      limitations: [],
    },
  };
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
    expect(await read(`${options.cwd}/repository/${related.path}`, "utf8")).toBe(related.content);
    expect(await read(`${options.cwd}/snapshot-0001.jsonl`, "utf8")).toContain("formatTime");
    const searchEvents = [
      JSON.stringify({
        type: "tool_use",
        part: {
          tool: "read",
          state: {
            status: "completed",
            input: { filePath: `repository/${related.path}` },
            output: `<content>\n1: ${related.content}\n</content>`,
          },
        },
      }),
      JSON.stringify({
        type: "tool_use",
        part: {
          tool: "grep",
          state: {
            status: "completed",
            input: { pattern: "formatTime", path: "repository/" },
            output: `repository/${related.path}:1:${related.content}`,
          },
        },
      }),
    ].join("\n");
    return (
      searchEvents +
      "\n" +
      readEvent("snapshot-0001.jsonl", reviewContext) +
      JSON.stringify({
        type: "text",
        part: { text: '{"summary":"No defects found","limitations":[],"findings":[]}' },
      }) +
      '\n{"type":"step_finish","part":{"reason":"stop"}}'
    );
  });
  const result = await createReviewAdapter({ verify: async () => {}, run })({
    binary: "/runtime",
    context: reviewContext,
  });
  expect(result.summary).toBe("No defects found");
});

it.each(["../escape.ts", "/absolute.ts", "repository//double.ts", "a/./b.ts"])(
  "rejects unsafe related repository path %s before the model runs",
  async (path) => {
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
      throw new Error("model must not run");
    });
    await expect(
      createReviewAdapter({ verify: async () => {}, run })({
        binary: "/runtime",
        context: {
          ...context,
          repository: {
            ...context.repository,
            related: [{ path, sha: "c".repeat(40), size: 1, reason: "Related", content: "x" }],
          },
        },
      }),
    ).rejects.toThrow("no review was produced");
    expect(run.mock.calls.map((call) => call[1][0])).toEqual(["debug"]);
  },
);

it("rejects related context over the caller limits before the model runs", async () => {
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
    throw new Error("model must not run");
  });
  const related = Array.from({ length: 25 }, (_, index) => ({
    path: `apps/web/src/shared/file-${index}.ts`,
    sha: "c".repeat(40),
    size: 1,
    reason: "Related file",
    content: "x",
  }));
  await expect(
    createReviewAdapter({ verify: async () => {}, run })({
      binary: "/runtime",
      context: {
        ...context,
        repository: { ...context.repository, related },
      },
    }),
  ).rejects.toThrow("no review was produced");
  expect(run.mock.calls.map((call) => call[1][0])).toEqual(["debug"]);
});

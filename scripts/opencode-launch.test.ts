import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createLaunchPlan, launchOpenCode } from "./opencode-launch.ts";

it("passes the configured model to opencode run and forwards only its credential", () => {
  const plan = createLaunchPlan({
    executable: "/runtime/opencode",
    args: ["run", "analyze the report"],
    base: {
      PATH: "/usr/bin:/bin",
      OPENCODE_MODEL: "deepseek/deepseek-flash",
      OPENCODE_API_KEY: "fixture-opencode-go",
      DEEPSEEK_API_KEY: "fixture-deepseek",
      AUDIT_URL: "https://example.invalid",
    },
  });
  expect(plan.args).toEqual(["run", "--model", "deepseek/deepseek-flash", "analyze the report"]);
  expect(plan.env).toMatchObject({
    MODEL: "deepseek/deepseek-flash",
    OPENCODE_MODEL: "deepseek/deepseek-flash",
    DEEPSEEK_API_KEY: "fixture-deepseek",
    AUDIT_URL: "https://example.invalid",
  });
  expect(plan.env.OPENCODE_API_KEY).toBeUndefined();
});

it("uses MODEL for the GitHub handler instead of an unsupported --model argument", () => {
  const plan = createLaunchPlan({
    executable: "/runtime/opencode",
    args: ["github", "run"],
    base: { OPENCODE_API_KEY: "fixture" },
  });
  expect(plan.args).toEqual(["github", "run"]);
  expect(plan.env.MODEL).toBe("opencode-go/deepseek-v4.1-flash");
});

it("rejects invalid models and missing credentials before spawning", () => {
  expect(() =>
    createLaunchPlan({
      executable: "/runtime/opencode",
      args: ["run", "prompt"],
      base: { OPENCODE_MODEL: "deepseek/deepseek-flash; id", OPENCODE_API_KEY: "fixture" },
    }),
  ).toThrow(/OpenCode model configuration is invalid/);
  expect(() =>
    createLaunchPlan({
      executable: "/runtime/opencode",
      args: ["run", "prompt"],
      base: { OPENCODE_MODEL: "deepseek/deepseek-flash", OPENCODE_API_KEY: "wrong-provider" },
    }),
  ).toThrow(/DEEPSEEK_API_KEY is required/);
  expect(() =>
    createLaunchPlan({
      executable: "/runtime/opencode\n--unsafe",
      args: ["run", "prompt"],
      base: { OPENCODE_API_KEY: "fixture" },
    }),
  ).toThrow(/OpenCode executable path is invalid/);
});

it("actually launches the configured executable with an argument array and exit status", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-launch-"));
  const executable = join(dir, "fake-opencode.mjs");
  const resultPath = join(dir, "result.json");
  try {
    await writeFile(
      executable,
      `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(process.env.LAUNCH_RESULT, JSON.stringify({ args: process.argv.slice(2), model: process.env.MODEL, opencodeModel: process.env.OPENCODE_MODEL, opencodeKey: process.env.OPENCODE_API_KEY, deepseekKey: process.env.DEEPSEEK_API_KEY }));\nprocess.exit(Number(process.env.LAUNCH_EXIT ?? 0));\n`,
    );
    await chmod(executable, 0o755);
    const status = await launchOpenCode({
      executable,
      args: ["run", "prompt"],
      base: {
        PATH: process.env.PATH,
        LAUNCH_RESULT: resultPath,
        OPENCODE_MODEL: "deepseek/deepseek-flash",
        OPENCODE_API_KEY: "fixture-opencode-go",
        DEEPSEEK_API_KEY: "fixture-deepseek",
      },
    });
    expect(status).toBe(0);
    expect(JSON.parse(await readFile(resultPath, "utf8"))).toEqual({
      args: ["run", "--model", "deepseek/deepseek-flash", "prompt"],
      model: "deepseek/deepseek-flash",
      opencodeModel: "deepseek/deepseek-flash",
      opencodeKey: undefined,
      deepseekKey: "fixture-deepseek",
    });
    expect(
      await launchOpenCode({
        executable,
        args: ["github", "run"],
        base: {
          PATH: process.env.PATH,
          LAUNCH_RESULT: resultPath,
          LAUNCH_EXIT: "7",
          OPENCODE_API_KEY: "fixture-opencode-go",
        },
      }),
    ).toBe(7);
    expect(JSON.parse(await readFile(resultPath, "utf8"))).toEqual({
      args: ["github", "run"],
      model: "opencode-go/deepseek-v4.1-flash",
      opencodeModel: "opencode-go/deepseek-v4.1-flash",
      opencodeKey: "fixture-opencode-go",
      deepseekKey: undefined,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

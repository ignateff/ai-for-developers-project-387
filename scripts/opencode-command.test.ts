import { expect, it } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertCommandAgent, createCommandEnvironment } from "./opencode-command.ts";
import { runCommand } from "./test-command.ts";

it("builds a dedicated command environment instead of inheriting developer configuration", () => {
  const env = createCommandEnvironment({
    workspace: "/trusted/checkout",
    directory: "/runner/command-9",
    base: {
      PATH: "/tools/bin:/usr/bin:/bin",
      HOME: "/runner/home",
      GH_TOKEN: "read-token",
      DEEPSEEK_API_KEY: "provider-key",
      RENDER_API_KEY: "unrelated-secret",
      OPENCODE_PERMISSION: '{"*":"allow"}',
      OPENCODE_CONFIG: "/unsafe/config.json",
      NODE_OPTIONS: "--import=/unsafe/plugin.js",
    },
  });
  expect(env.HOME).toBe("/runner/command-9/home");
  expect(env.TMPDIR).toBe("/runner/command-9/tmp");
  expect(env.MISE_DATA_DIR).toBe("/runner/home/.local/share/mise");
  expect(env.OPENCODE_PERMISSION).toBeUndefined();
  expect(env.OPENCODE_CONFIG).toBeUndefined();
  expect(env.NODE_OPTIONS).toBeUndefined();
  expect(env.RENDER_API_KEY).toBeUndefined();
  expect(env.DEEPSEEK_API_KEY).toBe("provider-key");
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!);
  expect(config.default_agent).toBe("build");
  expect(config.permission["*"]).toBe("deny");
  expect(config.permission.skill["*"]).toBe("deny");
  expect(config.permission.skill["to-spec"]).toBe("allow");
  expect(config.skills.paths).toEqual(["/runner/command-9/skills"]);
  expect(config.permission.external_directory).toEqual({
    "*": "deny",
    "/trusted/checkout/*": "allow",
    "/runner/command-9/*": "allow",
  });
  for (const name of ["question", "task", "plan_enter", "plan_exit", "doom_loop"]) {
    expect(config.permission[name]).toBe("deny");
  }
});

it("rejects a runtime agent that can still ask after the last global deny", () => {
  expect(() =>
    assertCommandAgent(
      {
        name: "build",
        permission: [
          { permission: "*", pattern: "*", action: "deny" },
          { permission: "external_directory", pattern: "/tmp/*", action: "ask" },
        ],
      },
      { workspace: "/trusted/checkout", directory: "/runner/command-9" },
    ),
  ).toThrow(/interactive/);
});

it.each([
  undefined,
  { permission: [] },
  { name: "build", permission: [{ permission: "*", pattern: "*", action: "allow" }] },
])("rejects missing, malformed or default-allow resolved agents", (agent) => {
  expect(() =>
    assertCommandAgent(agent, {
      workspace: "/trusted/checkout",
      directory: "/runner/command-9",
    }),
  ).toThrow(/OpenCode/);
});

it("CLI refuses a preparation with repository plugins before installation or provider access", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-command-cli-"));
  try {
    await mkdir(join(root, "workspace/.opencode"), { recursive: true });
    await expect(
      runCommand(process.execPath, ["scripts/opencode-command.ts", "prepare"], {
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          GITHUB_WORKSPACE: join(root, "workspace"),
          OPENCODE_COMMAND_DIR: join(root, "runtime"),
        },
      }),
    ).rejects.toThrow(/exit code 1[\s\S]*discovery/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("CLI rejects unknown commands and unprepared local runs", async () => {
  for (const command of ["unexpected", "run"]) {
    await expect(
      runCommand(process.execPath, ["scripts/opencode-command.ts", command], {
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
      }),
    ).rejects.toThrow(/exit code 1[\s\S]*OpenCode/);
  }
});

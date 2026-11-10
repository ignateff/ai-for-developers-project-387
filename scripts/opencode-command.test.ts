import { expect, it } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertCommandAgent,
  commandInstructions,
  commandSubagents,
  createCommandEnvironment,
  expectedAgentRules,
} from "./opencode-command.ts";
import { runCommand } from "./test-command.ts";

type Rule = { permission: string; pattern: string; action: string };

function actionFor(rules: Rule[], permission: string, pattern = "*"): string | undefined {
  return rules.findLast(
    (rule) => rule.permission === permission && (rule.pattern === "*" || rule.pattern === pattern),
  )?.action;
}

it("builds a dedicated command environment instead of inheriting developer configuration", () => {
  const env = createCommandEnvironment({
    workspace: "/trusted/checkout",
    directory: "/runner/command-9",
    base: {
      PATH: "/tools/bin:/usr/bin:/bin",
      HOME: "/runner/home",
      GH_TOKEN: "read-token",
      OPENCODE_API_KEY: "provider-key",
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
  expect(env.OPENCODE_API_KEY).toBe("provider-key");
  expect(env.MODEL).toBe("opencode-go/deepseek-v4.1-flash");
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
  for (const name of ["question", "plan_enter", "plan_exit", "doom_loop"]) {
    expect(config.permission[name]).toBe("deny");
  }
  expect(config.subagent_depth).toBe(1);
});

it("requires English Conventional Commits with an issue reference in the command runtime", () => {
  const instructions = commandInstructions();
  expect(instructions).toContain("commit message in English");
  expect(instructions).toContain("Conventional Commits 1.0.0 header");
  expect(instructions).toContain("Do not add a trailing period");
  expect(instructions).toContain('"Refs: #<issue>" footer');
  expect(instructions).toContain("Never invent an issue number");
  expect(instructions).toContain("Commit your own changes");
  expect(instructions).toContain("leave the working tree clean");
  const finalResponseInstruction = instructions
    .split("\n")
    .find((line) => line.startsWith("Begin your final response"));
  expect(finalResponseInstruction).toContain("valid Conventional Commits header");
  expect(finalResponseInstruction).toContain('"Refs: #<issue>" footer');
  expect(finalResponseInstruction).toContain("fallback commit");
  expect(instructions).toContain("can be shortened or rewritten");
  expect(instructions).toContain("mise run check");
});

it("allows only the approved subagent types through task", () => {
  const env = createCommandEnvironment({
    workspace: "/trusted/checkout",
    directory: "/runner/command-9",
    base: {},
  });
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!);
  expect(config.permission.task).toEqual({ "*": "deny", implementer: "allow", reviewer: "allow" });
  expect(Object.keys(config.agent).sort()).toEqual(["build", "implementer", "reviewer"]);
  for (const name of commandSubagents) expect(config.agent[name].mode).toBe("subagent");
});

it("gives implementers editing and command execution but no nested delegation", () => {
  const rules = expectedAgentRules(
    { workspace: "/trusted/checkout", directory: "/runner/command-9" },
    "implementer",
  );
  for (const permission of ["bash", "edit", "glob", "grep", "list", "todowrite", "webfetch"])
    expect(actionFor(rules, permission)).toBe("allow");
  expect(actionFor(rules, "task", "implementer")).toBe("deny");
  expect(actionFor(rules, "task", "general")).toBe("deny");
  expect(actionFor(rules, "read", "*.env")).toBe("deny");
  expect(actionFor(rules, "read", "app.ts")).toBe("allow");
});

it("limits reviewers to reading and searching", () => {
  const rules = expectedAgentRules(
    { workspace: "/trusted/checkout", directory: "/runner/command-9" },
    "reviewer",
  );
  for (const permission of ["read", "glob", "grep", "list"])
    expect(actionFor(rules, permission)).toBe("allow");
  for (const permission of [
    "bash",
    "edit",
    "todowrite",
    "webfetch",
    "websearch",
    "skill",
    "task",
    "question",
  ])
    expect(actionFor(rules, permission)).toBe("deny");
  expect(actionFor(rules, "read", "*.env")).toBe("deny");
  expect(rules).toContainEqual({
    permission: "external_directory",
    pattern: "/trusted/checkout/*",
    action: "allow",
  });
  expect(actionFor(rules, "external_directory", "/etc/passwd")).toBe("deny");
  expect(rules.some((rule) => rule.action === "ask")).toBe(false);
});

it("accepts only the resolved policy of the agent it names", () => {
  const paths = { workspace: "/trusted/checkout", directory: "/runner/command-9" };
  for (const name of ["build", ...commandSubagents] as const)
    expect(() =>
      assertCommandAgent({ name, permission: expectedAgentRules(paths, name) }, paths, name),
    ).not.toThrow();
  expect(() =>
    assertCommandAgent(
      { name: "reviewer", permission: expectedAgentRules(paths, "implementer") },
      paths,
      "reviewer",
    ),
  ).toThrow(/OpenCode/);
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

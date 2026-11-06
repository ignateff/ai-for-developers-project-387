import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { installRuntime, runtimeVersion, verifyInstalledRuntime } from "./opencode-install.ts";
import { assertSafeProject, assertSafePullRequest } from "./opencode-discovery.ts";
import { runGitHubHandler } from "./opencode-handler.ts";
import { commandSkills, verifyCommandSkills } from "./opencode-skills.ts";

const execute = promisify(execFile);

type EnvironmentOptions = {
  workspace: string;
  directory: string;
  base?: NodeJS.ProcessEnv;
};

export function createCommandEnvironment({
  workspace,
  directory,
  base = process.env,
}: EnvironmentOptions): NodeJS.ProcessEnv {
  for (const path of [workspace, directory]) {
    if (!isAbsolute(path) || resolve(path) !== path || /[*?\[\]{}\r\n]/.test(path) || path === "/")
      throw new Error("OpenCode paths must be absolute, non-root literal paths");
  }
  const home = join(directory, "home");
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (
      /^(GITHUB_|RUNNER_)/.test(key) ||
      [
        "PATH",
        "LANG",
        "LC_ALL",
        "TZ",
        "CI",
        "NODE_ENV",
        "PNPM_HOME",
        "GH_TOKEN",
        "DEEPSEEK_API_KEY",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "NO_PROXY",
        "ACTIONS_ID_TOKEN_REQUEST_URL",
        "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
      ].includes(key)
    )
      env[key] = value;
  }
  const permission = {
    "*": "deny",
    bash: "allow",
    edit: "allow",
    read: { "*": "allow", "*.env": "deny", "*.env.*": "deny", "*.env.example": "allow" },
    glob: "allow",
    grep: "allow",
    list: "allow",
    todowrite: "allow",
    webfetch: "allow",
    websearch: "allow",
    skill: { "*": "deny", ...Object.fromEntries(commandSkills.map((name) => [name, "allow"])) },
    external_directory: { "*": "deny", [`${workspace}/*`]: "allow", [`${directory}/*`]: "allow" },
    question: "deny",
    task: "deny",
    plan_enter: "deny",
    plan_exit: "deny",
    doom_loop: "deny",
  };
  Object.assign(env, {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_STATE_HOME: join(home, ".local/state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    TMPDIR: join(directory, "tmp"),
    TMP: join(directory, "tmp"),
    TEMP: join(directory, "tmp"),
    MISE_DATA_DIR:
      base.MISE_DATA_DIR ??
      join(base.XDG_DATA_HOME ?? join(base.HOME ?? home, ".local/share"), "mise"),
    MISE_CONFIG_DIR: join(home, ".config/mise"),
    MISE_STATE_DIR: join(home, ".local/state/mise"),
    MISE_CACHE_DIR: join(home, ".cache/mise"),
    MISE_TRUSTED_CONFIG_PATHS: workspace,
    OPENCODE_AUTH_CONTENT: "{}",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_PURE: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
    OPENCODE_DISABLE_FFF: "1",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      default_agent: "build",
      share: "disabled",
      autoupdate: false,
      formatter: false,
      lsp: false,
      snapshot: false,
      skills: { paths: [join(directory, "skills")] },
      permission,
      instructions: [join(workspace, "AGENTS.md"), join(directory, "instructions.md")],
      agent: { build: { permission } },
    }),
    MODEL: "deepseek/deepseek-flash",
    USE_GITHUB_TOKEN: "false",
    SHARE: "false",
  });
  return env;
}

type Rule = { permission: string; pattern: string; action: string };

export function assertCommandAgent(agent: unknown, paths: Omit<EnvironmentOptions, "base">): void {
  if (
    !agent ||
    typeof agent !== "object" ||
    !("name" in agent) ||
    agent.name !== "build" ||
    !("permission" in agent) ||
    !Array.isArray(agent.permission)
  )
    throw new Error("OpenCode resolved build agent is missing or invalid");
  const rules: Rule[] = agent.permission.map((rule: unknown) => {
    if (
      !rule ||
      typeof rule !== "object" ||
      !("permission" in rule) ||
      !("pattern" in rule) ||
      !("action" in rule) ||
      typeof rule.permission !== "string" ||
      typeof rule.pattern !== "string" ||
      !["allow", "deny", "ask"].includes(String(rule.action))
    )
      throw new Error("OpenCode resolved permission schema is invalid");
    return { permission: rule.permission, pattern: rule.pattern, action: String(rule.action) };
  });
  const lastDeny = rules.findLastIndex(
    (rule) => rule.permission === "*" && rule.pattern === "*" && rule.action === "deny",
  );
  if (lastDeny === -1) throw new Error("OpenCode resolved policy lacks a final default deny");
  const tail = rules.slice(lastDeny);
  if (tail.some((rule) => rule.action === "ask"))
    throw new Error("OpenCode resolved policy contains an interactive permission");

  const env = createCommandEnvironment({ ...paths, base: {} });
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!);
  const expected: Rule[] = [];
  for (const [permission, value] of Object.entries(config.permission)) {
    if (typeof value === "string") expected.push({ permission, pattern: "*", action: value });
    else
      for (const [pattern, action] of Object.entries(value as Record<string, string>)) {
        expected.push({ permission, pattern, action });
      }
  }
  // Upstream appends this one automatic allowance after the configured agent rules.
  const withOutput = [
    ...expected,
    {
      permission: "external_directory",
      pattern: join(env.XDG_DATA_HOME!, "opencode/tool-output/*"),
      action: "allow",
    },
  ];
  if (
    JSON.stringify(tail) !== JSON.stringify(expected) &&
    JSON.stringify(tail) !== JSON.stringify(withOutput)
  )
    throw new Error("OpenCode resolved policy differs from the approved command policy");
}

async function inspectAgent(
  binary: string,
  env: NodeJS.ProcessEnv,
  paths: Omit<EnvironmentOptions, "base">,
) {
  const inspection = { ...env };
  for (const key of ["DEEPSEEK_API_KEY", "GH_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"])
    delete inspection[key];
  let output: string;
  try {
    ({ stdout: output } = await execute(binary, ["debug", "agent", "build"], {
      cwd: paths.workspace,
      env: inspection,
      encoding: "utf8",
      timeout: 120000,
      killSignal: "SIGKILL",
      maxBuffer: 2 * 1024 * 1024,
    }));
  } catch {
    throw new Error("OpenCode configuration validation failed; resolved config was not logged");
  }
  let agent: unknown;
  try {
    agent = JSON.parse(output);
  } catch {
    throw new Error("OpenCode configuration validation returned invalid JSON");
  }
  assertCommandAgent(agent, paths);
}

async function inspectSource(base: NodeJS.ProcessEnv, workspace: string) {
  await assertSafeProject(workspace);
  if (!base.GITHUB_EVENT_PATH) throw new Error("OpenCode command event file is required");
  let event;
  try {
    event = JSON.parse(await readFile(base.GITHUB_EVENT_PATH, "utf8"));
  } catch {
    throw new Error("OpenCode command event file is invalid");
  }
  const review = base.GITHUB_EVENT_NAME === "pull_request_review_comment";
  if (!review && base.GITHUB_EVENT_NAME !== "issue_comment")
    throw new Error("OpenCode command event type is unsupported");
  if (review || event.issue?.pull_request) {
    await assertSafePullRequest({
      repository: base.GITHUB_REPOSITORY ?? "",
      number: review ? event.pull_request?.number : event.issue?.number,
      token: base.GH_TOKEN ?? "",
    });
  }
}

async function pathsFromEnvironment(base: NodeJS.ProcessEnv) {
  if (!base.GITHUB_WORKSPACE || !base.OPENCODE_COMMAND_DIR)
    throw new Error("OpenCode command workspace and runtime directory are required");
  const workspace = await realpath(base.GITHUB_WORKSPACE);
  const directory = resolve(base.OPENCODE_COMMAND_DIR);
  createCommandEnvironment({ workspace, directory, base: {} });
  if (directory === workspace || directory.startsWith(`${workspace}${sep}`))
    throw new Error("OpenCode command state must be outside the source checkout");
  return { workspace, directory };
}

export async function prepareCommand(base: NodeJS.ProcessEnv) {
  const paths = await pathsFromEnvironment(base);
  await inspectSource(base, paths.workspace);
  if (base.DEEPSEEK_API_KEY)
    throw new Error("OpenCode preparation must not receive provider credentials");
  // An existing state directory is not trusted, restored or silently cleaned.
  await mkdir(paths.directory, { mode: 0o700 });
  paths.directory = await realpath(paths.directory);
  const env = createCommandEnvironment({ ...paths, base });
  await mkdir(env.HOME!, { recursive: true, mode: 0o700 });
  await mkdir(env.TMPDIR!, { recursive: true, mode: 0o700 });
  await verifyCommandSkills(paths.workspace, paths.directory, true);
  await verifyCommandSkills(paths.workspace, paths.directory, false);
  await writeFile(
    join(paths.directory, "instructions.md"),
    [
      "Implement the approved request and follow the explicitly loaded AGENTS.md.",
      "Use TMPDIR for temporary files. Hard-coded external paths may be denied; do not broaden permissions.",
      "This is a headless build session: do not delegate, enter plan mode, or request interactive approval.",
      "Run mise install, mise run install, and the relevant tests; run mise run check before reporting completion.",
      "Report failed checks or blockers honestly. Do not call partial work a successful fix.",
      "The upstream GitHub handler handles publication after your final response.",
    ].join("\n"),
    { mode: 0o600, flag: "wx" },
  );
  const binary = await installRuntime({ directory: join(paths.directory, "runtime") });
  await verifyInstalledRuntime(binary);
  await inspectAgent(binary, env, paths);
  await writeFile(
    join(paths.directory, "state.json"),
    JSON.stringify({
      ...paths,
      binary,
      version: runtimeVersion,
    }),
    { mode: 0o600, flag: "wx" },
  );
  console.log(`OpenCode ${runtimeVersion} prepared; effective command policy is noninteractive`);
}

export async function runCommand(base: NodeJS.ProcessEnv) {
  if (base.GITHUB_ACTIONS !== "true")
    throw new Error("OpenCode publishing handler is restricted to the authorized GitHub workflow");
  const paths = await pathsFromEnvironment(base);
  if ((await realpath(paths.directory)) !== paths.directory)
    throw new Error("OpenCode state directory must be canonical");
  const statePath = join(paths.directory, "state.json");
  if (!(await lstat(statePath)).isFile()) throw new Error("OpenCode state must be a regular file");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  if (
    state.version !== runtimeVersion ||
    state.workspace !== paths.workspace ||
    state.directory !== paths.directory ||
    typeof state.binary !== "string" ||
    !state.binary.startsWith(`${paths.directory}/runtime/`) ||
    (await realpath(state.binary)) !== state.binary
  )
    throw new Error("OpenCode prepared runtime state is invalid");
  await inspectSource(base, paths.workspace);
  await verifyInstalledRuntime(state.binary);
  await verifyCommandSkills(paths.workspace, paths.directory, false);
  const env = createCommandEnvironment({ ...paths, base });
  await inspectAgent(state.binary, env, paths);
  if (!env.DEEPSEEK_API_KEY) throw new Error("OpenCode provider credentials are missing");
  await runGitHubHandler({ binary: state.binary, workspace: paths.workspace, env });
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 3) throw new Error("OpenCode command requires prepare or run");
    if (process.argv[2] === "prepare") await prepareCommand(process.env);
    else if (process.argv[2] === "run") await runCommand(process.env);
    else throw new Error("OpenCode command requires prepare or run");
  } catch (error) {
    const message =
      error instanceof Error && error.message.startsWith("OpenCode ")
        ? error.message
        : "OpenCode command failed; preparation or execution is incomplete";
    console.error(message);
    process.exitCode = 1;
  }
}

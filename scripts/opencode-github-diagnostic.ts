import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCommandEnvironment } from "./opencode-command.ts";
import { runGitHubHandler } from "./opencode-handler.ts";
import { installRuntime } from "./opencode-install.ts";
import { formatRuntimeLogSummary, summarizeRuntimeLog } from "./opencode-log-summary.ts";

const root = await mkdtemp(join(tmpdir(), "oc-github-diagnostic-"));
const workspace = join(root, "project");
const directory = join(root, "runtime");
// This diagnostic intentionally pins its own model instead of OPENCODE_MODEL:
// it exercises the handler with a bounded fixture and must not consume the
// shared production model or depend on its provider credential.
const diagnosticModel = "opencode/big-pickle";
try {
  await mkdir(workspace, { recursive: true });
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(workspace, "README.md"),
    "# Test calendar\nA fictional scheduling project.\n",
  );
  const git = (...args: string[]) => execFileSync("git", args, { cwd: workspace, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "Fixture");
  git("add", "README.md");
  git("commit", "-qm", "fixture");
  const env = createCommandEnvironment({
    workspace,
    directory,
    base: { ...process.env, OPENCODE_MODEL: "" },
  });
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!);
  const permission = {
    "*": "deny",
    read: "allow",
    glob: "allow",
    grep: "allow",
    task: { "*": "deny", reviewer: "allow" },
    question: "deny",
  };
  config.permission = permission;
  config.agent.build.permission = permission;
  config.instructions = [];
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
  env.MODEL = diagnosticModel;
  env.USE_GITHUB_TOKEN = "true";
  env.GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  env.PROMPT =
    "Use task to delegate exactly one read-only task to reviewer: read README.md and report its title and one sentence about the project. Report the result. Do not change files.";
  await mkdir(env.TMPDIR!, { recursive: true });
  const binary = await installRuntime({ directory: join(directory, "binary") });
  try {
    await runGitHubHandler({ binary, workspace, env, timeoutMs: 120_000 });
  } finally {
    const logdir = join(env.XDG_DATA_HOME!, "opencode", "log");
    let files: string[] = [];
    try {
      files = (await readdir(logdir)).filter((file) => file.endsWith(".log"));
    } catch {
      /* report no logs */
    }
    console.log(`Diagnostic log files: ${files.length}`);
    for (const [index, file] of files.entries()) {
      const data = await readFile(join(logdir, file));
      console.log(`Diagnostic log ${index + 1}: bytes=${data.length}`);
      console.log(formatRuntimeLogSummary(summarizeRuntimeLog(data.toString("utf8"))));
    }
  }
} catch {
  console.error("Diagnostic failed; inspect safe phase and summary output.");
  process.exitCode = 1;
} finally {
  await rm(root, { recursive: true, force: true });
}

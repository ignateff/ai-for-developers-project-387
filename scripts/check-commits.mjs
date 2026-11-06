import { spawnSync } from "node:child_process";

function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || "Git failed");
  return result.stdout.trim();
}

const head = git([
  "rev-parse",
  "--verify",
  "--end-of-options",
  `${process.env.CHECK_COMMIT_HEAD || "HEAD"}^{commit}`,
]);
let base = process.env.CHECK_COMMIT_BASE;
if (!base || /^0+$/.test(base)) {
  base = git(["merge-base", "origin/main", head]);
  // On main/scheduled runs, check the tip instead of silently checking nothing.
  if (base === git(["rev-parse", head])) base = git(["rev-parse", `${head}^`]);
}
// Resolve revisions before passing them to commitlint; refs are never shell code.
const from = git(["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`]);
const to = head;
const result = spawnSync("commitlint", ["--strict", "--from", from, "--to", to], {
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

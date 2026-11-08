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
// A force-pushed branch can leave the push event's previous SHA unreachable from
// the fresh checkout. In that case lint all commits unique to the new branch.
if (process.env.GITHUB_EVENT_NAME === "push" && /^[a-f0-9]{40}$/i.test(base)) {
  const previous = spawnSync("git", ["cat-file", "-e", `${base}^{commit}`], { encoding: "utf8" });
  if (previous.error) throw previous.error;
  if (previous.status !== 0) {
    const fallback = git(["merge-base", "origin/main", head]);
    if (fallback === head) throw new Error("Cannot determine a safe commit range for this push");
    console.error(`Previous push commit is unavailable; checking branch commits since ${fallback}`);
    base = fallback;
  }
}
// Resolve revisions before passing them to commitlint; refs are never shell code.
const from = git(["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`]);
const to = head;
const result = spawnSync("commitlint", ["--strict", "--from", from, "--to", to], {
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

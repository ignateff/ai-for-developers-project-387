import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

const worktree = resolve(
  execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim(),
);
const branch = execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim();
const main = execFileSync("git", ["worktree", "list", "--porcelain"], { encoding: "utf8" })
  .split("\n")[0]
  .slice("worktree ".length);
const expected = join(`${resolve(main)}.worktree`, branch.replaceAll("/", "-"));

if (!branch || worktree !== expected) {
  console.error(
    `Worktree path: ${worktree}\nExpected: ${expected}\nIf the host requires a managed path, report this constraint and retain its lifecycle.`,
  );
  process.exitCode = 1;
} else {
  console.log(`Worktree location verified: ${worktree}`);
}

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { validateException } from "./quality-gates-policy.mjs";

const roots: string[] = [];
const secretScript = resolve("scripts/check-secrets.mjs");
const commitScript = resolve("scripts/check-commits.mjs");

function command(cwd: string, executable: string, args: string[], env = {}) {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CHECK_COMMIT_BASE: "", CHECK_COMMIT_HEAD: "", ...env },
    timeout: 20_000,
  });
  if (result.error) throw result.error;
  return result;
}

function git(root: string, ...args: string[]) {
  const result = command(root, "git", ["-c", "core.hooksPath=/dev/null", ...args]);
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

function repository() {
  const root = mkdtempSync(join(tmpdir(), "calendar-gates-test-"));
  roots.push(root);
  git(root, "init", "--initial-branch=main");
  git(root, "config", "user.email", "fixture@example.test");
  git(root, "config", "user.name", "Gate fixture");
  writeFileSync(join(root, "README.md"), "# Fixture\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "chore: initial fixture");
  git(root, "switch", "-c", "scratch/quality-gates");
  return root;
}

function token() {
  // A random, synthetic GitHub-shaped token, never sent to GitHub for validation.
  return `ghp_${randomBytes(30).toString("hex")}`;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("secrets checks clean sources, untracked files and tracked gitignored files", () => {
  const root = repository();
  expect(command(root, "node", [secretScript]).status).toBe(0);
  writeFileSync(join(root, "candidate.txt"), `token = "${token()}"\n`);
  expect(command(root, "node", [secretScript]).status).toBe(1);
  writeFileSync(join(root, ".gitignore"), "candidate.txt\n");
  git(root, "add", "--force", "candidate.txt");
  expect(command(root, "node", [secretScript]).status).toBe(1);
});

test("staged secrets cannot be hidden by clean unstaged content or inline allow comments", () => {
  const root = repository();
  writeFileSync(join(root, "candidate.txt"), `token = "${token()}" # betterleaks:allow\n`);
  git(root, "add", "candidate.txt");
  writeFileSync(join(root, "candidate.txt"), "message = harmless\n");
  const status = git(root, "status", "--porcelain");
  const index = git(root, "rev-parse", ":candidate.txt");
  expect(command(root, "node", [secretScript, "--staged"]).status).toBe(1);
  expect(git(root, "status", "--porcelain")).toBe(status);
  expect(git(root, "rev-parse", ":candidate.txt")).toBe(index);
  expect(readFileSync(join(root, "candidate.txt"), "utf8")).toBe("message = harmless\n");
});

test("history scan still rejects a secret removed from the working tree", () => {
  const root = repository();
  writeFileSync(join(root, "candidate.txt"), `token = "${token()}"\n`);
  git(root, "add", ".");
  git(root, "commit", "-m", "test: synthetic secret");
  git(root, "rm", "candidate.txt");
  git(root, "commit", "-m", "test: remove synthetic secret");
  expect(command(root, "node", [secretScript]).status).toBe(1);
});

test("commit range checks every new message and rejects invalid revision inputs", () => {
  const root = repository();
  writeFileSync(
    join(root, "commitlint.config.mjs"),
    readFileSync(resolve("commitlint.config.mjs")),
  );
  // Resolve the shared preset from the project's installed toolchain.
  symlinkSync(resolve("node_modules"), join(root, "node_modules"), "dir");
  const base = git(root, "rev-parse", "HEAD");
  git(root, "update-ref", "refs/remotes/origin/main", base);
  git(root, "commit", "--allow-empty", "-m", "feat: valid message");
  const valid = command(root, "node", [commitScript]);
  expect(valid.status, valid.stdout + valid.stderr).toBe(0);
  git(root, "commit", "--allow-empty", "-m", "invalid message");
  git(root, "commit", "--allow-empty", "-m", "fix: valid tip cannot hide invalid predecessor");
  expect(command(root, "node", [commitScript], { CHECK_COMMIT_BASE: base }).status).not.toBe(0);
  expect(
    command(root, "node", [commitScript], { CHECK_COMMIT_BASE: "missing-revision" }).status,
  ).not.toBe(0);
});

test("Hadolint and ShellCheck fail on real violations", () => {
  const root = repository();
  writeFileSync(join(root, "Dockerfile"), "FROM node:24\nRUN cd /app\n");
  expect(command(root, "hadolint", ["--failure-threshold", "style", "Dockerfile"]).status).toBe(1);
  writeFileSync(join(root, "bad.sh"), "#!/usr/bin/env bash\necho $undefined_variable\n");
  expect(command(root, "shellcheck", ["bad.sh"]).status).toBe(1);
});

test("the configured commit-msg hook accepts conventional messages and rejects invalid ones", () => {
  const root = repository();
  const message = join(root, "message.txt");
  writeFileSync(message, "feat: valid hook fixture\n");
  const valid = command(process.cwd(), "hk", ["run", "commit-msg", message]);
  expect(valid.status, valid.stdout + valid.stderr).toBe(0);
  writeFileSync(message, "invalid hook fixture\n");
  expect(command(process.cwd(), "hk", ["run", "commit-msg", message]).status).not.toBe(0);
});

test("exception dates fail on invalid calendar dates, missing reasons and overdue reviews", () => {
  const reason = "Human approved a narrow documented temporary exception";
  const now = new Date("2026-11-06T12:00:00Z");
  expect(() => validateException({ reviewDate: "2026-12-06", reason }, now)).not.toThrow();
  for (const reviewDate of ["2026-02-31", "2026-13-01", "2026-11-05", "26-12-06", undefined]) {
    expect(() => validateException({ reviewDate, reason }, now)).toThrow();
  }
  expect(() => validateException({ reviewDate: "2026-12-06", reason: "fine" }, now)).toThrow();
});

test("workflow scanner rejects a real workflow violation", () => {
  const root = repository();
  mkdirSync(join(root, "config/quality-gates"), { recursive: true });
  writeFileSync(join(root, "config/quality-gates/workflow-exceptions.json"), '{"exceptions":[]}');
  mkdirSync(join(root, ".github/workflows"), { recursive: true });
  writeFileSync(
    join(root, ".github/workflows/bad.yml"),
    [
      "name: Bad fixture",
      "on: push",
      "permissions: {}",
      "jobs:",
      "  bad:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: echo ${{ secrets.DOES_NOT_EXIST }}",
      "",
    ].join("\n"),
  );
  const result = command(root, "node", [resolve("scripts/check-workflows.mjs")]);
  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(result.stdout).toContain("new findings");
});

test("OSV wrapper only accepts the exact approved package, version and advisory", () => {
  const root = repository();
  writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  mkdirSync(join(root, "config/quality-gates"), { recursive: true });
  cpSync(
    resolve("config/quality-gates/vulnerability-exceptions.json"),
    join(root, "config/quality-gates/vulnerability-exceptions.json"),
  );
  const bin = join(root, "bin");
  mkdirSync(bin);
  const executable = join(bin, "osv-scanner");
  writeFileSync(
    executable,
    "#!/usr/bin/env node\nprocess.stdout.write(process.env.FIXTURE_OSV_REPORT); process.exit(Number(process.env.FIXTURE_OSV_STATUS));\n",
  );
  chmodSync(executable, 0o755);
  const run = (packages: object[], status = 1) =>
    command(root, "node", [resolve("scripts/check-vulnerabilities.mjs")], {
      PATH: `${bin}:${process.env.PATH}`,
      FIXTURE_OSV_REPORT: JSON.stringify({
        results: [{ source: { path: join(root, "pnpm-lock.yaml") }, packages }],
      }),
      FIXTURE_OSV_STATUS: String(status),
    });
  const approved = {
    package: { ecosystem: "npm", name: "esbuild", version: "0.18.20" },
    vulnerabilities: [{ id: "GHSA-67mh-4wv8-2f99" }],
  };
  const accepted = run([approved]);
  expect(accepted.status, accepted.stdout + accepted.stderr).toBe(0);
  expect(run([{ package: approved.package }], 0).status).toBe(0);
  expect(run([{ ...approved, package: { ...approved.package, version: "0.18.19" } }]).status).toBe(
    1,
  );
  expect(run([{ ...approved, vulnerabilities: [{ id: "GHSA-new-advisory" }] }]).status).toBe(1);
  expect(run([]).status).toBe(1);
  expect(run([approved], 128).status).toBe(1);
  const policy = JSON.parse(
    readFileSync(join(root, "config/quality-gates/vulnerability-exceptions.json"), "utf8"),
  );
  policy.exceptions[0].reviewDate = "2000-01-01";
  writeFileSync(
    join(root, "config/quality-gates/vulnerability-exceptions.json"),
    JSON.stringify(policy),
  );
  expect(run([approved]).status).toBe(1);
});

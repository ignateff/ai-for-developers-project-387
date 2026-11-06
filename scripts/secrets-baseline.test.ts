import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { findingKey, validateBaseline, validateReport } from "./secrets-baseline.mjs";

const now = new Date("2026-11-06T12:00:00Z");
const finding = {
  scope: "snapshot",
  path: "example.txt",
  rule: "github-pat",
  line: 1,
  blob: "a".repeat(40),
};
function baseline(findings: object[] = [finding]) {
  return {
    version: 1,
    expires: "2026-12-06",
    reason: "Human-approved temporary acceptance of this exact synthetic test finding.",
    findings,
  };
}

test("baseline requires exact identities, meaningful review, and real calendar dates", () => {
  expect(validateBaseline(baseline(), now).has(findingKey(finding))).toBe(true);
  for (const expires of ["2026-02-30", "2026-13-01", "2026-2-01", "not a date", "2026-11-05"]) {
    expect(() => validateBaseline({ ...baseline(), expires }, now)).toThrow();
  }
  expect(() => validateBaseline(baseline(), new Date("2026-12-06T23:59:59Z"))).not.toThrow();
  expect(() => validateBaseline(baseline([]), new Date("2026-12-07T00:00:00Z"))).toThrow(/expired/);
  expect(() => validateBaseline({ ...baseline(), reason: "accepted" }, now)).toThrow();
  for (const changed of [
    { ...finding, blob: "*" },
    { ...finding, path: "../example.txt" },
    { ...finding, line: 0 },
    { ...finding, scope: "directory" },
    { ...finding, Secret: "must not be stored" },
  ])
    expect(() => validateBaseline(baseline([changed]), now)).toThrow();
  expect(() => validateBaseline(baseline([finding, finding]), now)).toThrow(/duplicate/);
});

test("matching binds snapshot content and history commit as well as exact location", () => {
  const accepted = validateBaseline(baseline(), now);
  for (const changed of [
    { ...finding, blob: "b".repeat(40) },
    { ...finding, path: "other.txt" },
    { ...finding, rule: "generic-password" },
    { ...finding, line: 2 },
    { ...finding, scope: "history", commit: "a".repeat(40) },
  ])
    expect(accepted.has(findingKey(changed))).toBe(false);
  const history = {
    scope: "history",
    path: "old.txt",
    rule: "github-pat",
    line: 3,
    commit: "b".repeat(40),
  };
  expect(validateBaseline(baseline([history]), now).has(findingKey(history))).toBe(true);
  expect(findingKey(history)).not.toBe(findingKey({ ...history, commit: "c".repeat(40) }));
});

test("scanner reports fail closed on status disagreement, warnings and incomplete data", () => {
  const report = [{ File: "example.txt", RuleID: "github-pat", StartLine: 1, Commit: "" }];
  expect(validateReport([], 0, "")).toEqual([]);
  expect(validateReport(report, 1, "7:00PM WRN leaks found: 1\n")).toEqual(report);
  for (const [value, status, log] of [
    [report, 0, ""],
    [[], 1, ""],
    [[], 2, ""],
    [null, 0, ""],
    [report, 1, ""],
    [report, 1, "WRN leaks found: 2"],
    [report, 1, "WRN leaks found: 1\nWRN skipped unreadable file"],
    [[], 0, "WRN skipped file"],
    [[], 0, "WRN leaks found: 0"],
    [[{ ...report[0], StartLine: undefined }], 1, "WRN leaks found: 1"],
  ] as const)
    expect(() => validateReport(value, status, log)).toThrow();
});

const roots: string[] = [];
const script = resolve("scripts/check-secrets.mjs");
function command(root: string, cmd: string, args: string[]) {
  const result = spawnSync(cmd, args, { cwd: root, encoding: "utf8", timeout: 20_000 });
  if (result.error) throw result.error;
  return result;
}
function git(root: string, ...args: string[]) {
  const result = command(root, "git", ["-c", "core.hooksPath=/dev/null", ...args]);
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}
function repository() {
  const root = mkdtempSync(join(tmpdir(), "calendar-baseline-test-"));
  roots.push(root);
  git(root, "init", "--initial-branch=main");
  git(root, "config", "user.email", "fixture@example.test");
  git(root, "config", "user.name", "Fixture");
  writeFileSync(join(root, "README.md"), "# Test\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "chore: fixture");
  return root;
}
function writeBaseline(root: string, value: object) {
  const file = join(root, "config/quality-gates/secrets-baseline.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value)}\n`);
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("CLI accepts reviewed exact blobs but rejects changed same-line secrets and staged content", () => {
  const root = repository();
  const token = `ghp_${randomBytes(18).toString("hex")}`;
  writeFileSync(join(root, "example.txt"), `token = "${token}"\n`);
  const blob = git(root, "hash-object", "example.txt");
  writeBaseline(root, baseline([{ ...finding, blob }]));
  const accepted = command(root, "node", [script]);
  expect(accepted.status, accepted.stdout + accepted.stderr).toBe(0);
  git(root, "add", "example.txt");
  expect(command(root, "node", [script, "--staged"]).status).toBe(0);
  const replacement = `ghp_${randomBytes(18).toString("hex")}`;
  writeFileSync(join(root, "example.txt"), `token = "${replacement}"\n`);
  const changed = command(root, "node", [script]);
  expect(changed.status).toBe(1);
  expect(changed.stdout + changed.stderr).not.toContain(replacement);
  expect(changed.stdout + changed.stderr).not.toContain(token);
  git(root, "add", "example.txt");
  writeFileSync(join(root, "example.txt"), "harmless\n");
  expect(command(root, "node", [script, "--staged"]).status).toBe(1);
});

test("CLI enforces expiry even without findings and requires the application policy", () => {
  const root = repository();
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "call-calendar" }));
  expect(command(root, "node", [script]).status).toBe(1);
  writeBaseline(root, { ...baseline([]), expires: "2000-01-01" });
  const expired = command(root, "node", [script]);
  expect(expired.status).toBe(1);
  expect(expired.stderr).toContain("expired");
});

test("CLI history exceptions cannot suppress the same finding in a new commit", () => {
  const root = repository();
  const token = `ghp_${randomBytes(18).toString("hex")}`;
  const source = `token = "${token}"\n`;
  writeFileSync(join(root, "example.txt"), source);
  git(root, "add", "example.txt");
  git(root, "commit", "-m", "test: synthetic finding");
  const commit = git(root, "rev-parse", "HEAD");
  const blob = git(root, "hash-object", "example.txt");
  git(root, "rm", "example.txt");
  git(root, "commit", "-m", "test: remove synthetic finding");
  writeBaseline(
    root,
    baseline([
      { ...finding, blob },
      { scope: "history", path: finding.path, rule: finding.rule, line: 1, commit },
    ]),
  );
  const accepted = command(root, "node", [script]);
  expect(accepted.status, accepted.stdout + accepted.stderr).toBe(0);
  writeFileSync(join(root, "example.txt"), source);
  git(root, "add", "example.txt");
  git(root, "commit", "-m", "test: repeat synthetic finding");
  const rejected = command(root, "node", [script]);
  expect(rejected.status).toBe(1);
  expect(rejected.stderr).toContain('"scope":"history"');
  expect(rejected.stderr).not.toContain(token);
});

test("checked-in policy contains only exact reviewed metadata and retains opaque-design risk", () => {
  const value = JSON.parse(
    readFileSync(resolve("config/quality-gates/secrets-baseline.json"), "utf8"),
  );
  expect(() => validateBaseline(value, now)).not.toThrow();
  expect(value.expires).toBe("2026-12-06");
  expect(value.reason).toContain("unverified");
  expect(
    value.findings.some(
      (entry: { path: string }) => entry.path === "docs/design/calendar-booking.pen",
    ),
  ).toBe(true);
});

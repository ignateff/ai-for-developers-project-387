import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { findingKey, validateBaseline, validateReport } from "./secrets-baseline.mjs";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0) throw new Error(`${command} failed; scan is incomplete`);
  return result.stdout;
}

const scratch = mkdtempSync(join(tmpdir(), "calendar-secrets-"));
try {
  const baselinePath = "config/quality-gates/secrets-baseline.json";
  // Standalone scratch-repository tests may have no exceptions. The actual
  // application must never silently lose its reviewed policy file.
  let accepted = new Set();
  if (existsSync(baselinePath)) {
    accepted = validateBaseline(JSON.parse(readFileSync(baselinePath, "utf8")));
  } else if (
    existsSync("package.json") &&
    JSON.parse(readFileSync("package.json", "utf8")).name === "call-calendar"
  ) {
    throw new Error("Required secrets baseline is missing");
  }
  const ignore = join(scratch, "empty-ignore");
  writeFileSync(ignore, "");
  const config = join(scratch, "config.toml");
  writeFileSync(config, "[extend]\nuseDefault = true\n");
  const flags = [
    "--config",
    config,
    "--redact=100",
    "--no-banner",
    "--no-color",
    "--log-level",
    "warn",
    "--ignore-gitleaks-allow",
    "--gitleaks-ignore-path",
    ignore,
    "--exit-code",
    "1",
    "--report-format",
    "json",
  ];
  const snapshot = join(scratch, "source");
  mkdirSync(snapshot);
  const blobs = new Map();
  const staged = process.argv.includes("--staged");
  if (!staged && run("git", ["rev-parse", "--is-shallow-repository"]).trim() !== "false") {
    throw new Error("Full history is required; fetch complete Git history before checking secrets");
  }
  const files = run(
    "git",
    staged
      ? ["ls-files", "--stage", "-z"]
      : ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  )
    .split("\0")
    .filter(Boolean);
  for (const entry of new Set(files)) {
    let file = entry;
    let index;
    if (staged) {
      const match = /^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(entry);
      if (!match || match[3] !== "0" || !["100644", "100755", "120000"].includes(match[1])) {
        throw new Error("Cannot completely scan an unresolved index or non-file Git entry");
      }
      file = match[4];
      index = match[2];
    }
    const destination = resolve(snapshot, file);
    if (!destination.startsWith(`${resolve(snapshot)}/`))
      throw new Error("Unsafe Git snapshot path");
    mkdirSync(dirname(destination), { recursive: true });
    if (staged) {
      writeFileSync(destination, run("git", ["cat-file", "blob", index], { encoding: null }));
    } else {
      let parent = dirname(file);
      while (parent !== ".") {
        try {
          if (lstatSync(parent).isSymbolicLink())
            throw new Error("Cannot scan tracked files through a directory symlink");
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        parent = dirname(parent);
      }
      let stat;
      try {
        stat = lstatSync(file);
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      // Scan link text, never follow links outside the selected Git snapshot.
      if (stat.isSymbolicLink()) writeFileSync(destination, readlinkSync(file));
      else if (stat.isFile()) copyFileSync(file, destination);
      else throw new Error("Cannot scan non-file Git entry");
    }
    blobs.set(file, run("git", ["hash-object", "--no-filters", "--", destination]).trim());
  }
  let total = 0;
  let exceptions = 0;
  const unexpected = [];
  function scan(scope, args) {
    const report = join(scratch, `${scope}.json`);
    const result = spawnSync("betterleaks", [...args, ...flags, "--report-path", report], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error || !existsSync(report))
      throw new Error("Scanner failed to produce a complete report");
    const findings = validateReport(
      JSON.parse(readFileSync(report, "utf8")),
      result.status,
      result.stderr,
    );
    if (result.stdout.trim()) throw new Error("Scanner emitted unexpected output");
    for (const finding of findings) {
      let path = finding.File;
      if (scope === "snapshot" && isAbsolute(path)) path = relative(snapshot, path);
      if (!path || path.startsWith("../") || isAbsolute(path))
        throw new Error("Invalid scanner finding path");
      const identity = { scope, path, rule: finding.RuleID, line: finding.StartLine };
      if (scope === "snapshot") {
        if (!blobs.has(path) || finding.Commit)
          throw new Error("Finding is outside the selected snapshot");
        identity.blob = blobs.get(path);
      } else {
        if (!finding.Commit) throw new Error("History finding is missing its commit identity");
        identity.commit = finding.Commit;
      }
      total++;
      if (accepted.has(findingKey(identity))) exceptions++;
      else unexpected.push(identity);
    }
  }
  scan("snapshot", ["dir", snapshot]);
  if (!staged) scan("history", ["git", "--log-opts=--full-history -m HEAD", "."]);
  for (const finding of unexpected)
    process.stderr.write(`Unaccepted secret finding: ${JSON.stringify(finding)}\n`);
  if (unexpected.length)
    throw new Error(`${unexpected.length} finding(s) require remediation or explicit human review`);
  process.stdout.write(
    `Secrets check passed: ${total} finding(s), ${exceptions} exact dated exception(s).\n`,
  );
} catch (error) {
  // Do not print scanner output, report values, or JSON parsing errors (which
  // can contain matched source). Only our fixed diagnostics are safe to log.
  const safe =
    error instanceof SyntaxError ? "Invalid JSON policy or scanner report" : error.message;
  process.stderr.write(`Secrets check failed: ${safe}\n`);
  process.exitCode = 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

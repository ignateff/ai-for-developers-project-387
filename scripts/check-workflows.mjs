import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { validateException } from "./quality-gates-policy.mjs";

const { exceptions } = JSON.parse(
  readFileSync("config/quality-gates/workflow-exceptions.json", "utf8"),
);
if (!Array.isArray(exceptions)) throw new Error("Missing workflow exceptions list");
for (const exception of exceptions) {
  validateException(exception);
  const digest = createHash("sha256").update(readFileSync(exception.path)).digest("hex");
  if (digest !== exception.sha256)
    throw new Error(`Review changed exception source: ${exception.path}`);
}
const result = spawnSync("jactionlint", ["--strict-exit", "--no-baseline", "--format", "json"], {
  encoding: "utf8",
});
if (result.error) throw result.error;
if (result.stderr) process.stderr.write(result.stderr);
if (result.status !== 0 && result.status !== 1)
  throw new Error(`jactionlint failed: ${result.status}`);
const findings = JSON.parse(result.stdout);
if (!Array.isArray(findings) || (result.status === 1 && findings.length === 0)) {
  throw new Error("Invalid or incomplete workflow scan");
}
const remaining = findings.filter(
  (finding) =>
    !exceptions.some(
      (exception) =>
        finding.filepath === exception.path &&
        finding.id === exception.rule &&
        finding.line === exception.line,
    ),
);
for (const finding of remaining) {
  console.error(`${finding.filepath}:${finding.line}: ${finding.id}: ${finding.message}`);
}
console.log(
  `Workflow lint: ${remaining.length} new findings; ${findings.length - remaining.length} dated exceptions.`,
);
process.exitCode = remaining.length ? 1 : 0;

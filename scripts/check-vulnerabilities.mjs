import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validateException } from "./quality-gates-policy.mjs";

const { exceptions } = JSON.parse(
  readFileSync("config/quality-gates/vulnerability-exceptions.json", "utf8"),
);
if (!Array.isArray(exceptions)) throw new Error("Missing vulnerability exceptions list");
for (const exception of exceptions) validateException(exception);
const scratch = mkdtempSync(join(tmpdir(), "calendar-osv-"));
try {
  // Do not accept implicit local scanner configuration that could hide findings.
  const config = join(scratch, "empty.toml");
  writeFileSync(config, "");
  const result = spawnSync(
    "osv-scanner",
    [
      "scan",
      "source",
      "--config",
      config,
      "--all-vulns",
      "--all-packages",
      "--lockfile",
      "pnpm-lock.yaml",
      "--format",
      "json",
    ],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0 && result.status !== 1)
    throw new Error(`OSV scan failed: ${result.status}`);
  const report = JSON.parse(result.stdout);
  if (!Array.isArray(report.results) || report.results.length === 0)
    throw new Error("Missing OSV results");
  let packages = 0;
  let findings = 0;
  let accepted = 0;
  for (const source of report.results) {
    if (
      typeof source.source?.path !== "string" ||
      realpathSync(resolve(source.source.path)) !== realpathSync("pnpm-lock.yaml") ||
      !Array.isArray(source.packages)
    ) {
      throw new Error("Unexpected OSV source or missing packages");
    }
    packages += source.packages.length;
    for (const item of source.packages) {
      if (
        !item.package ||
        (item.vulnerabilities !== undefined && !Array.isArray(item.vulnerabilities))
      ) {
        throw new Error("Invalid OSV package record");
      }
      for (const vulnerability of item.vulnerabilities ?? []) {
        if (typeof vulnerability.id !== "string") throw new Error("Missing vulnerability ID");
        findings++;
        const exception = exceptions.find(
          (entry) =>
            entry.path === "pnpm-lock.yaml" &&
            entry.ecosystem === item.package.ecosystem &&
            entry.package === item.package.name &&
            entry.version === item.package.version &&
            entry.id === vulnerability.id,
        );
        if (exception) accepted++;
        else
          console.error(
            `${item.package.name}@${item.package.version}: ${vulnerability.id}: ${vulnerability.summary ?? ""}`,
          );
      }
    }
  }
  if (packages === 0 || (result.status === 1 && findings === 0))
    throw new Error("Incomplete OSV scan");
  console.log(
    `OSV: ${packages} packages; ${findings - accepted} blocking advisories; ${accepted} dated exceptions.`,
  );
  process.exitCode = findings === accepted ? 0 : 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

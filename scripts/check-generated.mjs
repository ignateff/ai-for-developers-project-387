import { mkdtempSync, cpSync, symlinkSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const temporary = mkdtempSync(join(tmpdir(), "calendar-codegen-"));

function files(dir, base = "") {
  return readdirSync(join(dir, base), { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(base, entry.name);
      return entry.isDirectory() ? files(dir, path) : [path];
    })
    .sort();
}

try {
  for (const path of ["contract", "package.json", "tspconfig.yaml"]) {
    cpSync(resolve(root, path), join(temporary, path), { recursive: true });
  }
  symlinkSync(resolve(root, "node_modules"), join(temporary, "node_modules"), "dir");
  const result = spawnSync("pnpm", ["run", "generate"], { cwd: temporary, stdio: "inherit" });
  if (result.status !== 0) throw new Error("Generation failed");
  const expected = join(root, "generated");
  const actual = join(temporary, "generated");
  const expectedFiles = files(expected);
  const actualFiles = files(actual);
  if (
    JSON.stringify(expectedFiles) !== JSON.stringify(actualFiles) ||
    expectedFiles.some(
      (file) => !readFileSync(join(expected, file)).equals(readFileSync(join(actual, file))),
    )
  ) {
    throw new Error("Generated artifacts are stale; run pnpm run generate");
  }
  console.log("Generated artifacts are up to date.");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";

const root = resolve(import.meta.dirname, "..");
const checker = join(root, "scripts/check-matt-skills.mjs");
const directories = [
  "to-spec",
  "to-tickets",
  "implement-spec",
  "tdd",
  "code-review",
  "codebase-design",
];
const temporary: string[] = [];

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "matt-skills-"));
  temporary.push(dir);
  for (const name of directories) {
    cpSync(join(root, ".agents/skills", name), join(dir, ".agents/skills", name), {
      recursive: true,
    });
  }
  cpSync(join(root, ".agents/mattpocock-LICENSE"), join(dir, ".agents/mattpocock-LICENSE"));
  return dir;
}

function check(dir: string) {
  return spawnSync(process.execPath, [checker, dir], { encoding: "utf8" });
}

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("accepts the pinned skill files and license", () => {
  expect(() => execFileSync(process.execPath, [checker, fixture()])).not.toThrow();
});

test("rejects changed or missing files and extra files", () => {
  const dir = fixture();
  writeFileSync(join(dir, ".agents/skills/tdd/SKILL.md"), "changed");
  unlinkSync(join(dir, ".agents/skills/to-spec/SKILL.md"));
  writeFileSync(join(dir, ".agents/skills/code-review/extra.md"), "extra");
  const result = check(dir);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(".agents/skills/tdd/SKILL.md");
  expect(result.stderr).toContain(".agents/skills/to-spec/SKILL.md");
  expect(result.stderr).toContain(".agents/skills/code-review/extra.md");
});

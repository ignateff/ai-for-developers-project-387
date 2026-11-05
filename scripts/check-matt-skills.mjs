import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(process.argv[2] ?? project);
const hashes = JSON.parse(await readFile(join(project, "scripts/matt-skills-sha256.json"), "utf8"));
const skills = ["to-spec", "to-tickets", "implement-spec", "tdd", "code-review", "codebase-design"];
const actual = new Set();
let failed = false;

async function visit(path) {
  let entries;
  try {
    entries = await readdir(join(root, path), { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const name = `${path}/${entry.name}`;
    if (entry.isDirectory()) await visit(name);
    else actual.add(name);
  }
}

for (const skill of skills) await visit(`.agents/skills/${skill}`);
actual.add(".agents/mattpocock-LICENSE");
for (const name of actual) {
  if (!Object.hasOwn(hashes, name)) {
    console.error(`Unexpected file: ${name}`);
    failed = true;
    continue;
  }
  try {
    const content = await readFile(join(root, name));
    if (createHash("sha256").update(content).digest("hex") !== hashes[name]) {
      console.error(`Hash mismatch: ${name}`);
      failed = true;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    console.error(`Missing file: ${name}`);
    failed = true;
  }
}
for (const name of Object.keys(hashes)) {
  if (!actual.has(name)) {
    console.error(`Missing file: ${name}`);
    failed = true;
  }
}
if (failed) process.exitCode = 1;
else console.log(`Pinned skill files verified in ${relative(process.cwd(), root) || "."}`);

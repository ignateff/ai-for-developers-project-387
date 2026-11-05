import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const commandSkills = [
  "to-spec",
  "to-tickets",
  "implement-spec",
  "tdd",
  "code-review",
  "codebase-design",
  "triage",
  "grilling",
  "domain-modeling",
] as const;

async function files(root: string, path = ""): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
    const relative = join(path, entry.name);
    if (entry.isDirectory()) result.push(...(await files(root, relative)));
    else if (entry.isFile() && (await lstat(join(root, relative))).nlink === 1)
      result.push(relative);
    else throw new Error("OpenCode skill source contains an unsafe entry");
  }
  return result;
}

export async function verifyCommandSkills(workspace: string, directory: string, copy: boolean) {
  const manifest: Record<string, string> = JSON.parse(
    await readFile(join(workspace, "scripts/matt-skills-sha256.json"), "utf8"),
  );
  const allowed = new Set<string>(commandSkills);
  const expected = Object.entries(manifest).filter(([path]) => {
    const match = /^\.agents\/skills\/([^/]+)\/(.+)$/.exec(path);
    return !!match && allowed.has(match[1]);
  });
  for (const name of commandSkills) {
    if (!expected.some(([path]) => path === `.agents/skills/${name}/SKILL.md`))
      throw new Error("OpenCode skill manifest is incomplete");
  }
  const root = copy ? join(workspace, ".agents/skills") : join(directory, "skills");
  for (const path of copy
    ? [join(workspace, ".agents"), root, ...commandSkills.map((name) => join(root, name))]
    : [root]) {
    if (!(await lstat(path)).isDirectory())
      throw new Error("OpenCode skill path must be a directory");
  }
  const expectedPaths = expected.map(([path]) => path.slice(".agents/skills/".length)).sort();
  const actual = copy
    ? (
        await Promise.all(
          commandSkills.map(async (name) =>
            (await files(join(root, name))).map((path) => join(name, path)),
          ),
        )
      )
        .flat()
        .sort()
    : (await files(root)).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expectedPaths))
    throw new Error("OpenCode skill file set differs from manifest");
  for (const [path, digest] of expected) {
    const relative = path.slice(".agents/skills/".length);
    const content = await readFile(join(root, relative));
    if (
      !/^[a-f0-9]{64}$/.test(digest) ||
      createHash("sha256").update(content).digest("hex") !== digest
    )
      throw new Error("OpenCode skill checksum mismatch");
    if (copy) {
      const target = join(directory, "skills", relative);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, content, { mode: 0o600, flag: "wx" });
    }
  }
}

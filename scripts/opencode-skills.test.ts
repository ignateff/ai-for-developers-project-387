import { cp, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { commandSkills, verifyCommandSkills } from "./opencode-skills.ts";

const temporary: string[] = [];
const root = resolve(import.meta.dirname, "..");

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "oc-skills-"));
  temporary.push(dir);
  const workspace = join(dir, "workspace");
  const runtime = join(dir, "runtime");
  await mkdir(join(workspace, "scripts"), { recursive: true });
  await cp(
    join(root, "scripts/matt-skills-sha256.json"),
    join(workspace, "scripts/matt-skills-sha256.json"),
  );
  for (const name of commandSkills)
    await cp(join(root, ".agents/skills", name), join(workspace, ".agents/skills", name), {
      recursive: true,
    });
  return { workspace, runtime };
}

afterEach(async () => {
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});

it("copies only pinned skills and rejects tampering in the isolated copy", async () => {
  const { workspace, runtime } = await fixture();
  await verifyCommandSkills(workspace, runtime, true);
  await verifyCommandSkills(workspace, runtime, false);
  await writeFile(join(runtime, "skills/to-spec/SKILL.md"), "tampered");
  await expect(verifyCommandSkills(workspace, runtime, false)).rejects.toThrow(/checksum/);
});

it("rejects extra files and symlinks in skill sources", async () => {
  const { workspace, runtime } = await fixture();
  await writeFile(join(workspace, ".agents/skills/triage/unexpected.md"), "extra");
  await expect(verifyCommandSkills(workspace, runtime, true)).rejects.toThrow(/file set/);
  await rm(join(workspace, ".agents/skills/triage/unexpected.md"));
  await symlink(
    join(workspace, ".agents/skills/triage/SKILL.md"),
    join(workspace, ".agents/skills/triage/link.md"),
  );
  await expect(verifyCommandSkills(workspace, runtime, true)).rejects.toThrow(/unsafe/);
});

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("rejects a checkout that is not on main before fetching or building", () => {
  const dir = mkdtempSync(join(tmpdir(), "deploy-prepare-test-"));
  try {
    writeFileSync(join(dir, "git"), `#!${process.execPath}\nconsole.log('feature');\n`, {
      mode: 0o755,
    });
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("deploy-prepare.mjs", import.meta.url))],
      {
        cwd: dir,
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
        encoding: "utf8",
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("must already be on main");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const revision = "a".repeat(40);
const localImageId = `sha256:${"b".repeat(64)}`;
const files = [
  "Dockerfile",
  ".dockerignore",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "version.txt",
  "apps/api/package.json",
  "apps/web/package.json",
  "apps/web/src/app/main.tsx",
  "generated/sdk/client.ts",
  "apps/api/src/.env",
  "apps/api/src/private-key.ts",
  "apps/api/src/local.sqlite",
  "apps/api/src/token.json",
  "docs/secrets.txt",
];

function fixture(overrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "deploy-fixture-"));
  const entries = files.map((path, index) => ({
    path,
    object: (index + 1).toString(16).padStart(40, "0"),
  }));
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({ revision, localImageId, entries, ...overrides }),
  );
  writeFileSync(
    join(dir, "git"),
    `#!${process.execPath}
const fs = require('fs');
const path = require('path');
const dir = process.env.FIXTURE;
const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json')));
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'git.log'), JSON.stringify(args) + '\\n');
const command = args[0];
const calls = fs.readFileSync(path.join(dir, 'git.log'), 'utf8').trim().split('\\n').map(JSON.parse);
if (config.fail === command) process.exit(7);
if (command === 'branch') console.log(config.branch || 'main');
else if (command === 'status') console.log(config.statusSequence?.[calls.filter(c => c[0] === 'status').length - 1] || config.dirty || '');
else if (command === 'rev-parse' && args[1] === '--show-toplevel') console.log(dir);
else if (command === 'rev-parse') console.log((config.refSequence?.[calls.filter(c => c[0] === 'rev-parse' && c[1] === 'HEAD').length - 1] || config.refs || [config.revision, config.revision, config.revision]).join('\\n'));
else if (command === 'ls-tree') process.stdout.write(config.entries.map(e => (e.mode || '100644') + ' ' + (e.type || 'blob') + ' ' + e.object + '\\t' + e.path + '\\0').join(''));
else if (command === 'cat-file') process.stdout.write('content:' + config.entries.find(e => e.object === args[2]).path);
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(dir, "docker"),
    `#!${process.execPath}
const fs = require('fs');
const path = require('path');
const dir = process.env.FIXTURE;
const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json')));
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'docker.log'), JSON.stringify(args) + '\\n');
if (config.dockerFail) process.exit(8);
if (args[0] === 'build') {
  const context = args.at(-1);
  if (context !== '-') process.exit(12);
  if (config.changeContext) {
    const local = path.join(dir, 'Dockerfile');
    fs.writeFileSync(local, 'transient replacement');
    fs.unlinkSync(local);
  }
  const tar = fs.readFileSync(0);
  fs.writeFileSync(path.join(dir, 'snapshot.tar'), tar);
  const files = {};
  for (let p = 0; p + 512 <= tar.length;) {
    const name = tar.subarray(p, p + 100).toString().replace(/\0.*$/, '');
    if (!name) break;
    const size = parseInt(tar.subarray(p + 124, p + 136).toString().replace(/\0.*$/, '').trim(), 8) || 0;
    files[name] = tar.subarray(p + 512, p + 512 + size).toString();
    p += 512 + Math.ceil(size / 512) * 512;
  }
  fs.writeFileSync(path.join(dir, 'context.json'), JSON.stringify(Object.keys(files).sort()));
  fs.writeFileSync(path.join(dir, 'dockerfile-snapshot'), files.Dockerfile);
  fs.writeFileSync(args[args.indexOf('--iidfile') + 1], config.localImageId);
} else console.log(JSON.stringify([{ Id: config.localImageId, Os: 'linux', Architecture: config.arch || 'amd64', Config: { Labels: { 'org.opencontainers.image.revision': config.label || config.revision } } }]));
`,
    { mode: 0o755 },
  );
  const run = () =>
    spawnSync(process.execPath, [fileURLToPath(new URL("deploy-prepare.mjs", import.meta.url))], {
      cwd: dir,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, TMPDIR: dir, FIXTURE: dir },
      encoding: "utf8",
    });
  const log = (name: string) => {
    try {
      return readFileSync(join(dir, `${name}.log`), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  return { dir, run, log, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

it("builds only an allowlisted Git snapshot and records the inspected image provenance", () => {
  const f = fixture();
  try {
    const result = f.run();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const calls = f.log("git");
    expect(calls).toContainEqual([
      "fetch",
      "--no-tags",
      "--no-prune",
      "--no-recurse-submodules",
      "--no-write-fetch-head",
      "--refmap=",
      "origin",
      "refs/heads/main:refs/remotes/origin/main",
    ]);
    expect(calls).toContainEqual(["merge", "--ff-only", "--no-overwrite-ignore", "origin/main"]);
    expect(
      calls.some((args: string[]) => ["switch", "reset", "stash", "clean"].includes(args[0])),
    ).toBe(false);
    const docker = f.log("docker");
    expect(docker).toHaveLength(2);
    expect(docker[0]).toContain("linux/amd64");
    expect(docker[0]).toContain(`APP_REVISION=${revision}`);
    expect(docker[1]).toEqual(["image", "inspect", localImageId]);
    expect(JSON.parse(readFileSync(join(f.dir, "context.json"), "utf8"))).toEqual(
      files.slice(0, 10).sort(),
    );
    const recordPath = result.stdout.match(/provenance: (.+)\n/)?.[1];
    expect(recordPath).toBeDefined();
    const record = JSON.parse(readFileSync(recordPath!, "utf8"));
    expect(record).toMatchObject({
      sourceRevision: revision,
      platform: "linux/amd64",
      localImageId,
      registryDigest: null,
    });
    expect(record.contextManifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(record.contextArchiveSha256).toBe(
      createHash("sha256")
        .update(readFileSync(join(f.dir, "snapshot.tar")))
        .digest("hex"),
    );
    const listed = spawnSync("tar", ["-tf", "-"], {
      input: readFileSync(join(f.dir, "snapshot.tar")),
      encoding: "utf8",
    });
    expect(listed.status, listed.stderr).toBe(0);
    expect(listed.stdout.trim().split("\n").sort()).toEqual(files.slice(0, 10).sort());
    expect(record.contextManifest).toHaveLength(10);
    expect(result.stdout).toContain("Not published or deployed");
  } finally {
    f.cleanup();
  }
});

it("feeds a Git snapshot through stdin rather than a replaceable context directory", () => {
  const f = fixture({ changeContext: true });
  try {
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    expect(f.log("docker")[0].at(-1)).toBe("-");
    expect(readFileSync(join(f.dir, "dockerfile-snapshot"), "utf8")).toBe("content:Dockerfile");
  } finally {
    f.cleanup();
  }
});

it.each([
  [{ branch: "topic" }, "must already be on main"],
  [{ dirty: "?? untracked" }, "dirty or has untracked"],
  [{ dirty: " M tracked" }, "dirty or has untracked"],
  [{ fail: "fetch" }, "fetch"],
  [{ fail: "merge" }, "merge"],
  [{ refs: [revision, revision, "b".repeat(40)] }, "must be identical"],
  [{ refs: ["b".repeat(40), "b".repeat(40), revision] }, "must be identical"],
  [{ refs: ["unknown", "unknown", "unknown"] }, "must be identical"],
  [{ statusSequence: ["", "?? appeared"] }, "dirty or has untracked"],
])("fails closed before building for invalid Git state %#", (config, message) => {
  const f = fixture(config);
  try {
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
    expect(f.log("docker")).toEqual([]);
  } finally {
    f.cleanup();
  }
});

it.each([
  [{ dockerFail: true }, "docker"],
  [{ arch: "arm64" }, "inspection"],
  [{ label: "wrong" }, "inspection"],
  [{ localImageId: "unknown" }, "valid local image ID"],
  [{ statusSequence: ["", "", "", "?? appeared"] }, "dirty or has untracked"],
  [
    {
      refSequence: [
        [revision, revision, revision],
        [revision, revision, revision],
        ["b".repeat(40), "b".repeat(40), "b".repeat(40)],
      ],
    },
    "source revision changed",
  ],
])("does not claim success when image build or inspection fails %#", (config, message) => {
  const f = fixture(config);
  try {
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
    expect(result.stdout).not.toContain("provenance:");
  } finally {
    f.cleanup();
  }
});

it("rejects symlinks within the allowlist", () => {
  const entries = files.map((path, index) => ({
    path,
    object: (index + 1).toString(16).padStart(40, "0"),
    ...(path === "apps/web/src/app/main.tsx" ? { mode: "120000" } : {}),
  }));
  const f = fixture({ entries });
  try {
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unsafe Git tree entry");
    expect(f.log("docker")).toEqual([]);
  } finally {
    f.cleanup();
  }
});

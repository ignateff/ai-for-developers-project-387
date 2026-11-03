import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// All real Git operations are confined to this disposable directory. Docker is a substitute.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "deploy-git-regression-"));
  const origin = join(dir, "origin.git");
  const writer = join(dir, "writer");
  const checkout = join(dir, "checkout");
  const bin = join(dir, "bin");
  mkdirSync(writer);
  mkdirSync(bin);
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
    HOME: dir,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git(dir, "init", "--bare", "--initial-branch=main", origin);
  git(writer, "init", "--initial-branch=main");
  git(writer, "config", "user.name", "Test");
  git(writer, "config", "user.email", "test@example.invalid");
  const files: Record<string, string> = {
    Dockerfile: "FROM scratch\n",
    ".dockerignore": "*.sqlite\n",
    ".gitignore": "*.sqlite\n",
    "package.json": "{}\n",
    "pnpm-lock.yaml": "lock\n",
    "pnpm-workspace.yaml": "packages: []\n",
    "version.txt": "1.0.0\n",
    "apps/api/package.json": "{}\n",
    "apps/web/package.json": "{}\n",
    "apps/web/src/app/main.tsx": "original source\n",
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(writer, path, ".."), { recursive: true });
    writeFileSync(join(writer, path), content);
  }
  git(writer, "add", ".");
  git(writer, "commit", "-m", "initial");
  git(writer, "remote", "add", "origin", origin);
  git(writer, "push", "origin", "HEAD:refs/heads/main", "HEAD:refs/heads/other");
  git(dir, "clone", origin, checkout);
  writeFileSync(
    join(bin, "docker"),
    `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FIXTURE + '/docker.log', JSON.stringify(args) + '\\n');
const image = 'sha256:' + 'b'.repeat(64);
if (args[0] === 'build') {
  if (args.at(-1) !== '-') process.exit(12);
  const tar = fs.readFileSync(0);
  for (let p = 0; p + 512 <= tar.length;) {
    const name = tar.subarray(p, p + 100).toString().replace(/\0.*$/, '');
    if (!name) break;
    const size = parseInt(tar.subarray(p + 124, p + 136).toString().replace(/\0.*$/, '').trim(), 8) || 0;
    if (name === 'apps/web/src/app/main.tsx') fs.writeFileSync(process.env.FIXTURE + '/snapshot', tar.subarray(p + 512, p + 512 + size));
    p += 512 + Math.ceil(size / 512) * 512;
  }
  fs.writeFileSync(args[args.indexOf('--iidfile') + 1], image);
  fs.writeFileSync(process.env.FIXTURE + '/revision', args[args.indexOf('--build-arg') + 1].split('=')[1]);
} else console.log(JSON.stringify([{Id:image, Os:'linux', Architecture:'amd64', Config:{Labels:{'org.opencontainers.image.revision':fs.readFileSync(process.env.FIXTURE + '/revision', 'utf8')}}}]));
`,
    { mode: 0o755 },
  );
  const run = () =>
    spawnSync(process.execPath, [fileURLToPath(new URL("deploy-prepare.mjs", import.meta.url))], {
      cwd: checkout,
      env: {
        ...env,
        PATH: `${bin}:${process.env.PATH}`,
        TMPDIR: dir,
        FIXTURE: dir,
        GIT_NO_REPLACE_OBJECTS: "0",
      },
      encoding: "utf8",
    });
  return {
    dir,
    origin,
    writer,
    checkout,
    git,
    run,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

it("preserves an ignored local file when a fast-forward would overwrite it", () => {
  const f = fixture();
  try {
    const original = f.git(f.checkout, "rev-parse", "HEAD");
    writeFileSync(join(f.checkout, "local.sqlite"), "local data");
    writeFileSync(join(f.writer, "local.sqlite"), "remote data");
    f.git(f.writer, "add", "-f", "local.sqlite");
    f.git(f.writer, "commit", "-m", "add file");
    f.git(f.writer, "push", "origin", "HEAD:refs/heads/main");
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("git merge failed");
    expect(readFileSync(join(f.checkout, "local.sqlite"), "utf8")).toBe("local data");
    expect(f.git(f.checkout, "rev-parse", "HEAD")).toBe(original);
    expect(existsSync(join(f.dir, "docker.log"))).toBe(false);
  } finally {
    f.cleanup();
  }
});

it("fetches remote main despite a restricted configured fetch refspec", () => {
  const f = fixture();
  try {
    f.git(
      f.checkout,
      "config",
      "--replace-all",
      "remote.origin.fetch",
      "+refs/heads/other:refs/remotes/origin/other",
    );
    writeFileSync(join(f.writer, "apps/web/src/app/main.tsx"), "new remote source\n");
    f.git(f.writer, "add", ".");
    f.git(f.writer, "commit", "-m", "advance main");
    const remoteRevision = f.git(f.writer, "rev-parse", "HEAD");
    f.git(f.writer, "push", "origin", "HEAD:refs/heads/main");
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    expect(f.git(f.checkout, "rev-parse", "HEAD")).toBe(remoteRevision);
    expect(f.git(f.checkout, "rev-parse", "refs/remotes/origin/main")).toBe(remoteRevision);
    expect(readFileSync(join(f.dir, "snapshot"), "utf8")).toBe("new remote source\n");
  } finally {
    f.cleanup();
  }
});

it("fails when remote main is deleted even if a stale origin/main remains", () => {
  const f = fixture();
  try {
    f.git(
      f.checkout,
      "config",
      "--replace-all",
      "remote.origin.fetch",
      "+refs/heads/other:refs/remotes/origin/other",
    );
    const original = f.git(f.checkout, "rev-parse", "HEAD");
    f.git(f.dir, `--git-dir=${f.origin}`, "update-ref", "-d", "refs/heads/main");
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("git fetch failed");
    expect(f.git(f.checkout, "rev-parse", "HEAD")).toBe(original);
    expect(f.git(f.checkout, "rev-parse", "refs/remotes/origin/main")).toBe(original);
    expect(existsSync(join(f.dir, "docker.log"))).toBe(false);
  } finally {
    f.cleanup();
  }
});

it("ignores replacement objects when constructing the Git snapshot", () => {
  const f = fixture();
  try {
    const originalBlob = f.git(f.checkout, "rev-parse", "HEAD:apps/web/src/app/main.tsx");
    const malicious = join(f.dir, "replacement");
    writeFileSync(malicious, "replacement source\n");
    const replacement = f.git(f.checkout, "hash-object", "-w", malicious);
    f.git(f.checkout, "replace", originalBlob, replacement);
    expect(f.git(f.checkout, "cat-file", "blob", originalBlob)).toBe("replacement source");
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(f.dir, "snapshot"), "utf8")).toBe("original source\n");
  } finally {
    f.cleanup();
  }
});

it("does not force-update a tracking ref after remote main is rewound", () => {
  const f = fixture();
  try {
    const original = f.git(f.checkout, "rev-parse", "HEAD");
    writeFileSync(join(f.writer, "version.txt"), "2.0.0\n");
    f.git(f.writer, "add", "version.txt");
    f.git(f.writer, "commit", "-m", "advance");
    f.git(f.writer, "push", "origin", "HEAD:refs/heads/main");
    f.git(f.checkout, "fetch", "origin");
    const tracking = f.git(f.checkout, "rev-parse", "refs/remotes/origin/main");
    f.git(f.dir, `--git-dir=${f.origin}`, "update-ref", "refs/heads/main", original);
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("git fetch failed");
    expect(f.git(f.checkout, "rev-parse", "refs/remotes/origin/main")).toBe(tracking);
    expect(f.git(f.checkout, "rev-parse", "HEAD")).toBe(original);
    expect(existsSync(join(f.dir, "docker.log"))).toBe(false);
  } finally {
    f.cleanup();
  }
});

it("does not update or prune unrelated refs despite fetch configuration", () => {
  const f = fixture();
  try {
    const original = f.git(f.checkout, "rev-parse", "HEAD");
    f.git(f.checkout, "update-ref", "refs/remotes/origin/unexpected", original);
    f.git(f.checkout, "update-ref", "refs/remotes/origin/removed", original);
    f.git(
      f.checkout,
      "config",
      "--replace-all",
      "remote.origin.fetch",
      "+refs/heads/main:refs/remotes/origin/unexpected",
    );
    f.git(
      f.checkout,
      "config",
      "--add",
      "remote.origin.fetch",
      "+refs/heads/*:refs/remotes/origin/*",
    );
    f.git(f.checkout, "config", "fetch.prune", "true");
    writeFileSync(join(f.writer, "version.txt"), "2.0.0\n");
    f.git(f.writer, "add", "version.txt");
    f.git(f.writer, "commit", "-m", "advance");
    f.git(f.writer, "push", "origin", "HEAD:refs/heads/main");
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    expect(f.git(f.checkout, "rev-parse", "refs/remotes/origin/unexpected")).toBe(original);
    expect(f.git(f.checkout, "rev-parse", "refs/remotes/origin/removed")).toBe(original);
  } finally {
    f.cleanup();
  }
});

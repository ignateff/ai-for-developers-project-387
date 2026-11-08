import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import {
  downloadArchive,
  installRuntime,
  installVerifiedArchive,
  verifyInstalledRuntime,
} from "./opencode-install.ts";

const directories: string[] = [];

async function directory() {
  const path = await mkdtemp(join(tmpdir(), "opencode-install-test-"));
  directories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function archiveFixture(
  format: "tar.gz" | "zip",
  script = "#!/bin/sh\n[ \"$1\" = '--version' ] || exit 19\nprintf '1.19.5\\n'\n",
) {
  const root = await directory();
  const source = join(root, "source");
  await mkdir(source);
  await writeFile(join(source, "opencode"), script, { mode: 0o755 });
  const path = join(root, `fixture.${format}`);
  if (format === "tar.gz") {
    execFileSync("/usr/bin/tar", ["-czf", path, "-C", source, "opencode"]);
  } else {
    execFileSync("/usr/bin/zip", ["-q", path, "opencode"], { cwd: source });
  }
  const archive = await readFile(path);
  return { archive, sha256: createHash("sha256").update(archive).digest("hex"), format };
}

it.each([
  ["linux", "x64", "opencode-linux-x64.tar.gz"],
  ["darwin", "arm64", "opencode-darwin-arm64.zip"],
])(
  "downloads only the pinned %s/%s release and rejects unverified bytes",
  async (platform, arch, asset) => {
    const requests: string[] = [];
    await expect(
      installRuntime({
        directory: await directory(),
        platform,
        arch,
        fetch: async (url) => {
          requests.push(String(url));
          return new Response("not the release archive");
        },
      }),
    ).rejects.toThrow(/checksum/i);
    expect(requests).toEqual([
      `https://github.com/anomalyco/opencode/releases/download/v1.19.5/${asset}`,
    ]);
  },
);

it.each(["tar.gz", "zip"] as const)(
  "installs a verified %s archive into a fresh absolute executable path",
  async (format) => {
    const root = await directory();
    const installed = await installVerifiedArchive({
      directory: root,
      ...(await archiveFixture(format)),
    });
    expect(isAbsolute(installed)).toBe(true);
    expect(installed.startsWith(`${await realpath(root)}/`)).toBe(true);
    expect(execFileSync(installed, ["--version"], { encoding: "utf8" }).trim()).toBe("1.19.5");
  },
);

it("aborts an active runtime version check and cleans its staging directory", async () => {
  const root = await directory();
  const fixture = await archiveFixture("tar.gz", "#!/bin/sh\nsleep 30 &\nwait\n");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 250);
  try {
    await expect(
      installVerifiedArchive({ directory: root, ...fixture, signal: controller.signal }),
    ).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  } finally {
    clearTimeout(timer);
  }
}, 5000);

it("cancels a stalled download stream when preparation is aborted", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const promise = installRuntime({
    directory: await directory(),
    platform: "linux",
    arch: "x64",
    signal: controller.signal,
    fetch: async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      ),
  });
  setTimeout(() => controller.abort(), 50);
  await expect(promise).rejects.toThrow(/download/i);
  expect(cancelled).toBe(true);
}, 5000);

it("returns the archive after a transient download failure", async () => {
  const fixture = await archiveFixture("tar.gz");
  let calls = 0;
  const archive = await downloadArchive({
    url: "https://example.invalid/opencode.tar.gz",
    download: async () => {
      calls++;
      if (calls === 1) throw new Error("private-network-error");
      return new Response(fixture.archive);
    },
    options: { attempts: 2, budgetMs: 5000, backoffMs: 0 },
  });
  expect(calls).toBe(2);
  expect(createHash("sha256").update(archive).digest("hex")).toBe(fixture.sha256);
});

it("retries a bounded number of download failures without exposing diagnostics", async () => {
  let calls = 0;
  const failure = installRuntime({
    directory: await directory(),
    platform: "linux",
    arch: "x64",
    download: { attempts: 2, budgetMs: 5000, backoffMs: 0 },
    fetch: async () => {
      calls++;
      throw new Error("private-network-error");
    },
  });
  await expect(failure).rejects.toThrow(/download failed after 2 attempt/i);
  await expect(failure).rejects.not.toThrow(/private-network-error/);
  expect(calls).toBe(2);
});

it("does not retry a download cancelled by preparation", async () => {
  const controller = new AbortController();
  let calls = 0;
  const failure = downloadArchive({
    url: "https://example.invalid/opencode.tar.gz",
    download: async () => {
      calls++;
      controller.abort();
      throw new Error("private-network-error");
    },
    cancellation: controller.signal,
    options: { attempts: 3, budgetMs: 5000, backoffMs: 0 },
  });
  await expect(failure).rejects.toThrow(/download failed after 1 attempt/i);
  await expect(failure).rejects.not.toThrow(/private-network-error/);
  expect(calls).toBe(1);
});

it.each([
  "#!/bin/sh\nprintf '9.9.9 private-version-output\\n'\n",
  "#!/bin/sh\nprintf 'private-version-output\\n' >&2\nexit 3\n",
])("rejects an unexpected or failed version check without exposing output", async (script) => {
  const root = await directory();
  const failure = installVerifiedArchive({
    directory: root,
    ...(await archiveFixture("tar.gz", script)),
  });
  await expect(failure).rejects.toThrow(/version/i);
  await expect(failure).rejects.not.toThrow(/private-version-output/);
  expect(await readdir(root)).toEqual([]);
});

it("rejects unsupported targets before downloading or consulting PATH", async () => {
  let downloaded = false;
  await expect(
    installRuntime({
      directory: await directory(),
      platform: "linux",
      arch: "arm64",
      fetch: async () => {
        downloaded = true;
        throw new Error("must not download");
      },
    }),
  ).rejects.toThrow(/unsupported/i);
  expect(downloaded).toBe(false);
});

it.each([
  async () => {
    throw new Error("private-network-error");
  },
  async () => new Response("private-network-error", { status: 403 }),
  async () =>
    new Response("private-network-error", { headers: { "content-length": "9999999999" } }),
])(
  "fails closed on download errors without running a pre-existing binary or exposing diagnostics",
  async (fetch) => {
    const root = await directory();
    const stale = join(root, "opencode");
    await writeFile(stale, "#!/bin/sh\ntouch stale-ran\nprintf '1.19.5\\n'\n", { mode: 0o755 });
    const failure = installRuntime({ directory: root, platform: "linux", arch: "x64", fetch });
    await expect(failure).rejects.toThrow(/download/i);
    await expect(failure).rejects.not.toThrow(/private-network-error/);
    expect(await readdir(root)).toEqual(["opencode"]);
  },
);

it("CLI requires exactly one directory argument and leaves stdout empty on failure", async () => {
  const run = promisify(execFile);
  for (const args of [[], ["one", "two"]]) {
    const failure = run(process.execPath, ["scripts/opencode-install.ts", ...args], {
      timeout: 5_000,
    });
    await expect(failure).rejects.toMatchObject({
      code: 1,
      stdout: "",
      stderr: expect.stringMatching(/usage/i),
    });
  }
});

it("extracts afresh rather than executing a tampered prior installation that reports the right version", async () => {
  const root = await directory();
  const fixture = await archiveFixture("tar.gz");
  const previous = await installVerifiedArchive({ directory: root, ...fixture });
  const marker = join(root, "tampered-ran");
  await writeFile(previous, `#!/bin/sh\ntouch '${marker}'\nprintf '1.19.5\\n'\n`);
  const fresh = await installVerifiedArchive({ directory: root, ...fixture });
  expect(fresh).not.toBe(previous);
  expect(await readdir(root)).not.toContain("tampered-ran");
  expect(await readFile(fresh, "utf8")).not.toContain("tampered-ran");
});

it("corrupt bytes cannot fall back to a cached binary with the correct self-reported version", async () => {
  const root = await directory();
  const marker = join(root, "stale-ran");
  await writeFile(join(root, "opencode"), `#!/bin/sh\ntouch '${marker}'\nprintf '1.19.5\\n'\n`, {
    mode: 0o755,
  });
  await expect(
    installRuntime({
      directory: root,
      platform: "linux",
      arch: "x64",
      fetch: async () => new Response("corrupt"),
    }),
  ).rejects.toThrow(/checksum/i);
  expect(await readdir(root)).toEqual(["opencode"]);
});

it.each(["tar.gz", "zip"] as const)(
  "fails closed on authenticated but invalid %s archives and removes staging",
  async (format) => {
    const root = await directory();
    const archive = Buffer.from("not an archive: private-extraction-output");
    await expect(
      installVerifiedArchive({
        directory: root,
        archive,
        sha256: createHash("sha256").update(archive).digest("hex"),
        format,
      }),
    ).rejects.toThrow(/extraction/i);
    expect(await readdir(root)).toEqual([]);
  },
);

it("refuses an archive whose executable is a symlink without executing its target", async () => {
  const root = await directory();
  const source = await directory();
  const marker = join(source, "symlink-ran");
  const target = join(source, "outside");
  await writeFile(target, `#!/bin/sh\ntouch '${marker}'\nprintf '1.19.5\\n'\n`, { mode: 0o755 });
  await symlink(target, join(source, "opencode"));
  const path = join(source, "symlink.tar.gz");
  execFileSync("/usr/bin/tar", ["-czf", path, "-C", source, "opencode"]);
  const archive = await readFile(path);
  await expect(
    installVerifiedArchive({
      directory: root,
      archive,
      sha256: createHash("sha256").update(archive).digest("hex"),
      format: "tar.gz",
    }),
  ).rejects.toThrow(/extraction/i);
  expect(await readdir(source)).not.toContain("symlink-ran");
  expect(await readdir(root)).toEqual([]);
});

it("limits a chunked download even when no Content-Length is supplied", async () => {
  let cancelled = false;
  const chunk = new Uint8Array(1024 * 1024);
  const body = new ReadableStream({
    pull(controller) {
      controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  });
  await expect(
    installRuntime({
      directory: await directory(),
      platform: "linux",
      arch: "x64",
      fetch: async () => new Response(body),
    }),
  ).rejects.toThrow(/download/i);
  expect(cancelled).toBe(true);
});

it("CLI reports a failed download on stderr without leaking raw errors or claiming a path", async () => {
  const run = promisify(execFile);
  const hook = `data:text/javascript,${encodeURIComponent("globalThis.fetch = async () => { throw new Error('private-cli-network-error') }")}`;
  const failure = run(
    process.execPath,
    ["--import", hook, "scripts/opencode-install.ts", await directory()],
    { timeout: 5_000 },
  );
  await expect(failure).rejects.toMatchObject({
    code: 1,
    stdout: "",
    stderr: expect.stringMatching(/download/i),
  });
  await expect(failure).rejects.not.toMatchObject({
    stderr: expect.stringContaining("private-cli-network-error"),
  });
});

it("reverification rejects a forged binary before executing even its version command", async () => {
  const root = await directory();
  const marker = join(root, "forged-ran");
  const executable = join(root, "opencode");
  await writeFile(executable, `#!/bin/sh\ntouch '${marker}'\nprintf '1.19.5\\n'\n`, {
    mode: 0o755,
  });
  await expect(verifyInstalledRuntime(executable)).rejects.toThrow(/checksum/i);
  expect(await readdir(root)).toEqual(["opencode"]);
});

it("reverification refuses symlinked binaries", async () => {
  const root = await directory();
  const executable = join(root, "opencode");
  await writeFile(join(root, "target"), "#!/bin/sh\nprintf '1.19.5\\n'\n", { mode: 0o755 });
  await symlink(join(root, "target"), executable);
  await expect(verifyInstalledRuntime(executable)).rejects.toThrow(/regular file/i);
});

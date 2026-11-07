import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runIsolatedProcess } from "./opencode-process.ts";

const maxArchiveBytes = 256 * 1024 * 1024;

export const runtimeVersion = "1.19.5";
const version = runtimeVersion;
// Release source: 810c0eba1a7348036f8bdf61e6632d0c36c6876c.
// Digests are pinned from the GitHub release API, not downloaded with the artifact.
const releases = {
  "linux-x64": {
    asset: "opencode-linux-x64.tar.gz",
    sha256: "588310a336fa3b9df36b3f0225b26f679d453efaad0cf3d66c3651ef3ec1647a",
    executableSha256: "7df4e4136301f16589b0f30bf91a61380fca5f8ef22dd36570f5ebe1d4ec802c",
    format: "tar.gz",
  },
  "darwin-arm64": {
    asset: "opencode-darwin-arm64.zip",
    sha256: "c1c9e62521192192ef4c3ed1355ada2144055bddb61682217e997b03c55203c1",
    executableSha256: "feaafead8cd563af0c2dcb386b0757e4355e327ebb6bd1aaad5440fe2f83596c",
    format: "zip",
  },
} as const;

export async function verifyInstalledRuntime(
  executable: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const target = `${process.platform}-${process.arch}`;
  if (target !== "linux-x64" && target !== "darwin-arm64")
    throw new Error("Unsupported OpenCode runtime platform/architecture");
  const stat = await lstat(executable);
  if (!stat.isFile() || stat.nlink !== 1)
    throw new Error("OpenCode runtime must be a regular file");
  const digest = createHash("sha256")
    .update(await readFile(executable, { signal }))
    .digest("hex");
  if (digest !== releases[target].executableSha256)
    throw new Error("OpenCode executable checksum mismatch");
  if (
    (await command(executable, ["--version"], resolve(executable, ".."), signal)).trim() !== version
  )
    throw new Error("OpenCode version check failed");
}

export interface InstallRuntimeOptions {
  directory: string;
  platform?: string;
  arch?: string;
  fetch?: (url: string, options: { signal: AbortSignal }) => Promise<Response>;
  signal?: AbortSignal;
}

export async function installRuntime(options: InstallRuntimeOptions): Promise<string> {
  const target = `${options.platform ?? process.platform}-${options.arch ?? process.arch}`;
  if (target !== "linux-x64" && target !== "darwin-arm64")
    throw new Error("Unsupported OpenCode runtime platform/architecture");
  const release = releases[target];
  const archive = await downloadArchive(
    `https://github.com/anomalyco/opencode/releases/download/v${version}/${release.asset}`,
    options.fetch ?? fetch,
    options.signal,
  );
  return installVerifiedArchive({
    directory: options.directory,
    archive,
    ...release,
    signal: options.signal,
  });
}

async function downloadArchive(
  url: string,
  download: NonNullable<InstallRuntimeOptions["fetch"]>,
  cancellation?: AbortSignal,
): Promise<Buffer> {
  const timeout = AbortSignal.timeout(120_000);
  const signal = cancellation ? AbortSignal.any([timeout, cancellation]) : timeout;
  try {
    const response = await download(url, { signal });
    signal.throwIfAborted();
    if (!response.ok || !response.body) throw new Error("HTTP failure");
    if (Number(response.headers.get("content-length")) > maxArchiveBytes)
      throw new Error("Archive too large");
    const reader = response.body.getReader();
    const cancel = () => {
      void reader.cancel().catch(() => {});
    };
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        signal.throwIfAborted();
        if (done) break;
        size += value.byteLength;
        if (size > maxArchiveBytes) throw new Error("Archive too large");
        chunks.push(value);
      }
    } catch (error) {
      void reader.cancel().catch(() => {});
      throw error;
    } finally {
      signal.removeEventListener("abort", cancel);
      reader.releaseLock();
    }
    return Buffer.concat(chunks, size);
  } catch {
    throw new Error("OpenCode archive download failed (network, HTTP, size limit, or timeout)");
  }
}

/**
 * Archive authentication/extraction boundary, also usable with small test fixtures.
 * Production callers must use installRuntime, which does not accept digest overrides.
 */
export async function installVerifiedArchive(options: {
  directory: string;
  archive: Uint8Array;
  sha256: string;
  format: "tar.gz" | "zip";
  signal?: AbortSignal;
}): Promise<string> {
  options.signal?.throwIfAborted();
  if (createHash("sha256").update(options.archive).digest("hex") !== options.sha256)
    throw new Error("OpenCode archive checksum mismatch");
  await mkdir(resolve(options.directory), { recursive: true });
  const root = await realpath(options.directory);
  const staging = await mkdtemp(join(root, "opencode-"));
  let phase = "archive extraction";
  try {
    const archivePath = join(staging, `runtime.${options.format}`);
    await writeFile(archivePath, options.archive, {
      mode: 0o600,
      flag: "wx",
      signal: options.signal,
    });
    if (options.format === "tar.gz") {
      await command(
        "/usr/bin/tar",
        ["-xzf", archivePath, "-C", staging, "--", "opencode"],
        staging,
        options.signal,
      );
    } else {
      await command(
        "/usr/bin/unzip",
        ["-q", archivePath, "opencode", "-d", staging],
        staging,
        options.signal,
      );
    }
    const executable = join(staging, "opencode");
    const stat = await lstat(executable);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size === 0)
      throw new Error("OpenCode archive executable must be a regular file");
    await chmod(executable, 0o700);
    await rm(archivePath);
    phase = "version check";
    if ((await command(executable, ["--version"], staging, options.signal)).trim() !== version)
      throw new Error("Unexpected version");
    return executable;
  } catch {
    await rm(staging, { recursive: true, force: true });
    throw new Error(`OpenCode ${phase} failed`);
  }
}

async function command(
  file: string,
  args: string[],
  directory: string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const temp = join(directory, ".tmp");
  await mkdir(temp, { recursive: true });
  signal?.throwIfAborted();
  return runIsolatedProcess(file, args, {
    cwd: directory,
    env: { PATH: "/usr/bin:/bin", HOME: directory, TMPDIR: temp, LANG: "C" },
    timeout: 30_000,
    maxBuffer: 64 * 1024,
    signal,
  });
}

if (import.meta.main) {
  if (process.argv.length !== 3 || !process.argv[2]) {
    console.error("Usage: node scripts/opencode-install.ts <directory>");
    process.exitCode = 1;
  } else {
    try {
      console.log(await installRuntime({ directory: process.argv[2] }));
    } catch (error) {
      console.error(
        error instanceof Error && error.message.startsWith("OpenCode ")
          ? error.message
          : "OpenCode installation failed",
      );
      process.exitCode = 1;
    }
  }
}

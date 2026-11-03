import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import { build } from "vite";
import { readBuildInfo } from "./build-info.ts";

const directories: string[] = [];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "calendar-build-info-"));
  directories.push(directory);
  writeFileSync(join(directory, "version.txt"), "1.2.3\n");
  return pathToFileURL(`${directory}/`);
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

it("reads the release version relative to the config, not the working directory", () => {
  expect(readBuildInfo().version).toBe(
    readFileSync(new URL("../../version.txt", import.meta.url), "utf8").trim(),
  );
  expect(readBuildInfo(fixture(), "abcdef1234567890")).toEqual({
    version: "1.2.3",
    revision: "abcdef1",
  });
});

it("uses the checkout revision when no build argument is provided", () => {
  const root = fixture();
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  git("init", "--quiet");
  git(
    "-c",
    "user.name=Build Test",
    "-c",
    "user.email=build@example.test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "--quiet",
    "-m",
    "fixture",
  );
  vi.stubEnv("APP_REVISION", "");
  expect(readBuildInfo(root).revision).toBe(git("rev-parse", "HEAD").trim().slice(0, 7));
});

it("prefers an explicit build revision over the checkout", () => {
  vi.stubEnv("APP_REVISION", " 1234567890abcdef\n");
  expect(readBuildInfo().revision).toBe("1234567");
});

it("uses unknown without Git metadata and does not block the build", () => {
  vi.stubEnv("APP_REVISION", "");
  expect(readBuildInfo(fixture())).toEqual({ version: "1.2.3", revision: "unknown" });
});

it.each(["unknown", "not-a-hash", "abc", 'abc1234";alert(1)'])(
  "uses unknown for an unavailable or invalid explicit revision: %s",
  (revision) => {
    vi.stubEnv("APP_REVISION", revision);
    expect(readBuildInfo().revision).toBe("unknown");
  },
);

it.each([
  ["abcdef1234567890", "abcdef1"],
  ["unknown", "unknown"],
])(
  "embeds production metadata and logs it without a dev marker (%s)",
  async (revision, expected) => {
    vi.stubEnv("APP_REVISION", revision);
    const result = await build({
      root: fileURLToPath(new URL("./", import.meta.url)),
      configFile: fileURLToPath(new URL("vite.config.ts", import.meta.url)),
      logLevel: "silent",
      build: {
        write: false,
        rollupOptions: { input: fileURLToPath(new URL("src/app/log-version.ts", import.meta.url)) },
      },
    });
    if (Array.isArray(result) || !("output" in result)) throw new Error("Expected a single build");
    const entry = result.output.find((item) => item.type === "chunk" && item.isEntry);
    if (!entry || entry.type !== "chunk") throw new Error("Missing version entry");
    const info = vi.fn();
    runInNewContext(entry.code, { console: { info } });
    const version = readFileSync(new URL("../../version.txt", import.meta.url), "utf8").trim();
    expect(info.mock.calls).toEqual([[`Calendar v${version} (${expected})`]]);
  },
);

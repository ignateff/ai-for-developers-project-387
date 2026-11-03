import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.each([
  ["abcdef1234567890", "abcdef1", 0],
  ["unknown", "unknown", 23],
])(
  "passes the revision to Docker and preserves its exit status (%s)",
  (revision, expected, status) => {
    const directory = mkdtempSync(join(tmpdir(), "calendar-docker-command-"));
    try {
      writeFileSync(
        join(directory, "docker"),
        `#!${process.execPath}
console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));
process.exit(${status});
`,
        { mode: 0o755 },
      );
      const result = spawnSync(
        process.execPath,
        [fileURLToPath(new URL("build-docker.mjs", import.meta.url)), "--no-cache"],
        {
          cwd: directory,
          env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, APP_REVISION: revision },
          encoding: "utf8",
        },
      );
      expect(result.stderr).toBe("");
      expect(result.status).toBe(status);
      expect(JSON.parse(result.stdout)).toEqual({
        args: [
          "build",
          "--build-arg",
          `APP_REVISION=${expected}`,
          "-t",
          "call-calendar",
          "--no-cache",
          ".",
        ],
        cwd: fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, ""),
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

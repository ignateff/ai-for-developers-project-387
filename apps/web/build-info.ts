import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export function readBuildInfo(
  root = new URL("../../", import.meta.url),
  revision = process.env.APP_REVISION,
) {
  const version = readFileSync(new URL("version.txt", root), "utf8").trim();
  revision = revision?.trim();
  if (!revision) {
    try {
      revision = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      revision = "unknown";
    }
  }
  return {
    version,
    revision: /^[a-f\d]{7,40}$/i.test(revision) ? revision.slice(0, 7) : "unknown",
  };
}

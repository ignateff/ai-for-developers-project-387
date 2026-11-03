import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const daemons = JSON.parse(execFileSync("mise", ["daemons", "ls", "--json"], { encoding: "utf8" }));
const stateDir = daemons.find((daemon) => daemon.name === "web")?.state_dir;
if (!stateDir) throw new Error("Cannot find daemon state directory");
try {
  process.stdout.write(readFileSync(join(stateDir, "calendar-proxy-target"), "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

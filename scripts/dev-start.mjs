import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const list = () =>
  JSON.parse(execFileSync("mise", ["daemons", "ls", "--json"], { encoding: "utf8" }));
const initial = list();
const previouslyRunning = new Set(
  initial.filter((daemon) => daemon.status === "running").map((daemon) => daemon.name),
);
try {
  const pitchfork = JSON.parse(execFileSync("pitchfork", ["list", "--json"], { encoding: "utf8" }));
  for (const [name, requested] of [
    ["api", process.env.PORT],
    ["web", process.env.WEB_PORT],
  ]) {
    if (requested !== undefined && previouslyRunning.has(name)) {
      const id = initial.find((daemon) => daemon.name === name)?.id;
      const actual = pitchfork.find((daemon) => daemon.id === id)?.port?.[0];
      if (String(actual) !== requested) {
        throw new Error(`${name} is already running on port ${actual}, not ${requested}`);
      }
    }
  }
  if (previouslyRunning.has("web") && process.env.API_PROXY_TARGET !== undefined) {
    const stateDir = initial.find((daemon) => daemon.name === "web")?.state_dir;
    const current = readFileSync(join(stateDir, "calendar-proxy-target"), "utf8");
    if (current !== process.env.API_PROXY_TARGET) {
      throw new Error("web is already running with a different API_PROXY_TARGET");
    }
  }
  for (const [name, requested] of [
    ["api", process.env.PORT],
    ["web", process.env.WEB_PORT],
  ]) {
    if (name === "web" && !previouslyRunning.has("web")) {
      const daemons = list();
      const stateDir = daemons.find((daemon) => daemon.name === "web")?.state_dir;
      if (!stateDir) throw new Error("Cannot find daemon state directory");
      writeFileSync(join(stateDir, "calendar-proxy-target"), process.env.API_PROXY_TARGET ?? "");
    }
    const args = ["daemons", "start", name];
    if (requested !== undefined) {
      if (!/^[0-9]+$/.test(requested) || Number(requested) < 1 || Number(requested) > 65535) {
        throw new Error(`Invalid port for ${name}: ${requested}`);
      }
      args.push("--expected-port", requested, "--bump", "0");
    }
    execFileSync("mise", args, { stdio: "inherit" });
  }
  await import("./dev-url.mjs");
} catch (error) {
  for (const name of ["web", "api"]) {
    if (!previouslyRunning.has(name)) {
      try {
        execFileSync("mise", ["daemons", "stop", name], { stdio: "inherit" });
      } catch (cleanupError) {
        console.error(`Failed to stop ${name}:`, cleanupError.message);
      }
    }
  }
  console.error(error.message);
  process.exitCode = 1;
}

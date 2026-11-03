import { spawnSync } from "node:child_process";
import { readBuildInfo } from "../apps/web/build-info.ts";

const { revision } = readBuildInfo();
const result = spawnSync(
  "docker",
  [
    "build",
    "--build-arg",
    `APP_REVISION=${revision}`,
    "-t",
    "call-calendar",
    ...process.argv.slice(2),
    ".",
  ],
  { cwd: new URL("../", import.meta.url), stdio: "inherit" },
);
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;

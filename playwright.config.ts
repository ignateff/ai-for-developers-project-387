import { defineConfig } from "@playwright/test";
import { FIXED_NOW } from "./e2e/fixed-now";

const apiPort = Number(process.env.E2E_API_PORT ?? 3319);
const webPort = Number(process.env.E2E_WEB_PORT ?? 5319);
if (![apiPort, webPort].every((port) => Number.isInteger(port) && port > 0 && port <= 65535))
  throw new Error("Invalid E2E port");
export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  use: { baseURL: `http://127.0.0.1:${webPort}`, browserName: "chromium" },
  webServer: [
    {
      command: `DATABASE_PATH=:memory: CALENDAR_FIXED_NOW=${FIXED_NOW} PORT=${apiPort} mise run dev-api`,
      url: `http://127.0.0.1:${apiPort}/api/health`,
      reuseExistingServer: false,
    },
    {
      command: `API_PROXY_TARGET=http://127.0.0.1:${apiPort} mise run dev-web -- --port ${webPort} --strictPort`,
      url: `http://127.0.0.1:${webPort}`,
      reuseExistingServer: false,
    },
  ],
});

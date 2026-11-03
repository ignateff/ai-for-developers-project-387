import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { readBuildInfo } from "./build-info.ts";

const { version, revision } = readBuildInfo();

export default defineConfig(({ command }) => ({
  plugins: [react()],
  define: {
    __APP_VERSION_MESSAGE__: JSON.stringify(
      `Calendar v${version} (${revision})${command === "serve" ? " [dev]" : ""}`,
    ),
  },
  server: { proxy: { "/api": process.env.API_PROXY_TARGET ?? "http://127.0.0.1:3000" } },
}));

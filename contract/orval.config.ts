import { defineConfig } from "orval";

export default defineConfig({
  calendar: {
    input: "../generated/openapi/openapi.yaml",
    output: { target: "../generated/sdk/client.ts", client: "fetch" },
  },
});

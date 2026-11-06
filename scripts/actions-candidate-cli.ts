import { readFile } from "node:fs/promises";
import { inspectExperiment } from "./actions-experiment.ts";

// Explicit local invocation only. Never print the input, token, API body, or errors.
try {
  if (process.argv.length !== 3 || !process.env.GITHUB_TOKEN) throw new Error();
  const input = JSON.parse(await readFile(process.argv[2], "utf8"));
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error();
  const result = await inspectExperiment({ ...input, token: process.env.GITHUB_TOKEN });
  console.log(JSON.stringify(result));
} catch {
  console.log(JSON.stringify({ decision: "infra", reason: "invalid-input-or-file" }));
  process.exitCode = 1;
}

import { appendFile, readFile } from "node:fs/promises";
import { inspectGate } from "./actions-gate.ts";

// This entry point cannot emit an admission or succeed as a model gate.
try {
  const result = await inspectGate({
    repository: process.env.GITHUB_REPOSITORY ?? "",
    owner: process.env.GITHUB_REPOSITORY_OWNER ?? "",
    token: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? "",
    workflowId: Number(process.env.ADMISSION_WORKFLOW_ID),
    currentRunId: Number(process.env.GITHUB_RUN_ID),
    boundaryRunId: Number(process.env.ADMISSION_BOUNDARY_RUN_ID),
    event: process.env.GITHUB_EVENT_NAME ?? "",
    payload: JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH ?? "", "utf8")),
  });
  console.log(JSON.stringify(result));
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `decision=${result.decision}\n`);
    if ("hypothetical" in result && result.hypothetical === "would-admit")
      await appendFile(process.env.GITHUB_OUTPUT, "metadata_candidate=would-admit\n");
  }
  // This gate always fails; a separate metadata marker is not authorization.
  process.exitCode = 1;
} catch {
  console.log(JSON.stringify({ decision: "infra", reason: "invalid-event-file-or-output" }));
  process.exitCode = 1;
}

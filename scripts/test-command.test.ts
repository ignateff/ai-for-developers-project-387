import { expect, test } from "vitest";
import { runCommand } from "./test-command";

test("returns stdout from a completed command", async () => {
  await expect(runCommand(process.execPath, ["-e", 'process.stdout.write("ready")'])).resolves.toBe(
    "ready",
  );
});

test("reports command, exit code and captured output on failure", async () => {
  await expect(
    runCommand(process.execPath, [
      "-e",
      'console.log("starting"); console.error("broken"); process.exit(7)',
    ]),
  ).rejects.toThrow(/exit code 7[\s\S]*starting[\s\S]*broken/);
});

test("times out a stalled command and preserves startup diagnostics", async () => {
  await expect(
    runCommand(
      process.execPath,
      ["-e", 'console.error("waiting for readiness"); setInterval(() => {}, 1000)'],
      { timeout: 300 },
    ),
  ).rejects.toThrow(/timed out after 300ms[\s\S]*waiting for readiness/);
});

test("enforces the deadline even when the command ignores SIGTERM", async () => {
  const started = performance.now();
  await expect(
    runCommand(
      process.execPath,
      [
        "-e",
        'process.on("SIGTERM", () => {}); console.log("stalled"); setTimeout(() => process.exit(0), 1200)',
      ],
      { timeout: 300 },
    ),
  ).rejects.toThrow(/timed out after 300ms[\s\S]*stalled/);
  expect(performance.now() - started).toBeLessThan(1000);
}, 2000);

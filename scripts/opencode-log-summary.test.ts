import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  formatRuntimeLogSummary,
  readRuntimeLog,
  summarizeRuntimeLog,
} from "./opencode-log-summary.ts";

it("counts only allowlisted runtime events and never prints raw fields", () => {
  const text = [
    "timestamp=2026-11-08T09:00:00.000Z level=INFO run=abc message=loop session.id=s step=1",
    "timestamp=2026-11-08T09:00:01.000Z level=INFO run=abc message=process model.id=private-model",
    'timestamp=2026-11-08T09:00:02.000Z level=INFO run=abc message="shell tool using shell" shell=/bin/bash arg="private-argument"',
    'timestamp=2026-11-08T09:00:03.000Z level=INFO run=abc message="resolved path" arg="private-path" resolved="/private/location"',
    'timestamp=2026-11-08T09:00:04.000Z level=INFO run=abc message=evaluated permission=bash pattern="*" action=allow token=private-token',
    'timestamp=2026-11-08T09:00:05.000Z level=INFO run=abc message=asking id=x permission=bash patterns="private-pattern"',
    "timestamp=2026-11-08T09:00:06.000Z level=INFO run=abc message=loop session.id=s step=2",
    "timestamp=2026-11-08T09:00:07.000Z level=INFO run=abc message=ignored value=private-value",
  ].join("\n");
  const summary = summarizeRuntimeLog(text);
  expect(summary).toEqual({
    lines: 8,
    truncated: false,
    loop: 2,
    maxStep: 2,
    process: 1,
    evaluated: 1,
    asking: 1,
    shell: 1,
    paths: 1,
  });
  const output = formatRuntimeLogSummary(summary);
  expect(output).toBe(
    "OpenCode runtime log: loop=2 max_step=2 process=1 evaluated=1 asking=1 shell=1 paths=1 lines=8 truncated=no",
  );
  expect(output).not.toContain("private");
});

it("reports no loop step when the log has no loop events", () => {
  const summary = summarizeRuntimeLog("message=process\n");
  expect(summary.loop).toBe(0);
  expect(summary.maxStep).toBeNull();
  expect(formatRuntimeLogSummary(summary)).toContain("max_step=none");
});

it("reads the prepared runtime log and reports a missing file as unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-log-summary-"));
  try {
    expect(await readRuntimeLog(join(root, "missing.log"))).toBeNull();
    const directory = join(root, "home", ".local/share/opencode/log");
    await mkdir(directory, { recursive: true });
    const path = join(directory, "opencode.log");
    await writeFile(path, "message=loop step=3\n");
    const log = await readRuntimeLog(path);
    expect(log).not.toBeNull();
    expect(formatRuntimeLogSummary(summarizeRuntimeLog(log!.text))).toContain("loop=1 max_step=3");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

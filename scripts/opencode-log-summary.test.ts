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
    sessions: 0,
    subagentSessions: 0,
    subagentTypes: { implementer: 0, reviewer: 0, other: 0 },
    taskAllowed: 0,
    taskDenied: 0,
    taskAsk: 0,
    starts: 0,
    completions: 0,
    cancellations: 0,
    errors: 0,
    maxSubagentSeconds: null,
    maxConcurrentSubagents: null,
    concurrencyExceeded: "unknown",
  });
  const output = formatRuntimeLogSummary(summary);
  expect(output).toContain(
    "OpenCode runtime log: stage=command loop=2 max_step=2 process=1 evaluated=1 asking=1 shell=1 paths=1",
  );
  expect(output).toContain("tool_name=unknown");
  expect(output).toContain("result=unknown");
  expect(output).not.toContain("private");
});

it("reports delegation starts, approved types, completions and durations without raw data", () => {
  const text = [
    'timestamp=2026-11-08T09:00:00.000Z level=INFO run=abc message=created id=ses_root title="private root prompt" agent=build',
    "timestamp=2026-11-08T09:00:01.000Z level=INFO run=abc message=evaluated permission=task pattern=implementer action.permission=task action.pattern=implementer action.action=allow",
    'timestamp=2026-11-08T09:00:02.000Z level=INFO run=abc message=created id=ses_child parentID=ses_root title="private child prompt" agent=implementer',
    'timestamp=2026-11-08T09:00:03.000Z level=INFO run=abc message=created id=ses_review parentID=ses_root title="private review prompt" agent=reviewer',
    'timestamp=2026-11-08T09:00:04.000Z level=INFO run=abc message=evaluated permission=task pattern=explore action.permission=task action.pattern=explore action.action=deny metadata.description="private"',
    'timestamp=2026-11-08T09:00:05.000Z level=INFO run=abc message=evaluated permission=task pattern="custom-secret-type" action.permission=task action.pattern="custom-secret-type" action.action=deny',
    "timestamp=2026-11-08T09:00:06.000Z level=INFO run=abc message=cancel session.id=ses_review",
    'timestamp=2026-11-08T09:00:09.000Z level=INFO run=abc message="exiting loop" session.id=ses_child',
    'timestamp=2026-11-08T09:00:10.000Z level=ERROR run=abc message="subtask execution failed" error="private error"',
    'timestamp=2026-11-08T09:00:11.000Z level=INFO run=abc message="exiting loop" session.id=ses_root',
  ].join("\n");
  const summary = summarizeRuntimeLog(text);
  expect(summary.sessions).toBe(3);
  expect(summary.subagentSessions).toBe(2);
  expect(summary.starts).toBe(2);
  expect(summary.subagentTypes).toEqual({ implementer: 1, reviewer: 1, other: 0 });
  expect(summary.taskAllowed).toBe(1);
  expect(summary.taskDenied).toBe(2);
  expect(summary.taskAsk).toBe(0);
  expect(summary.completions).toBe(2);
  expect(summary.cancellations).toBe(1);
  expect(summary.errors).toBe(1);
  expect(summary.maxSubagentSeconds).toBe(7);
  expect(summary.maxConcurrentSubagents).toBe(2);
  expect(summary.concurrencyExceeded).toBe("no");
  const output = formatRuntimeLogSummary(summary);
  expect(output).toContain("subagent_sessions=2");
  expect(output).toContain("subagent_types=implementer:1,reviewer:1,other:0");
  expect(output).toContain("task_allowed=1");
  expect(output).toContain("task_denied=2");
  expect(output).toContain("max_subagent_seconds=7");
  expect(output).toContain("concurrency_limit=2");
  expect(output).toContain("max_concurrent_subagents=2");
  expect(output).toContain("concurrency_enforced=no");
  expect(output).toContain("concurrency_exceeded=no");
  expect(output).not.toContain("ses_root");
  expect(output).not.toContain("ses_child");
  expect(output).not.toContain("private");
  expect(output).not.toContain("custom-secret-type");
});

it("flags more than two concurrent subagents and never claims enforcement", () => {
  const text = [
    'timestamp=2026-11-08T09:00:00.000Z level=INFO run=abc message=created id=root title="t" agent=build',
    'timestamp=2026-11-08T09:00:01.000Z level=INFO run=abc message=created id=a parentID=root title="t" agent=implementer',
    'timestamp=2026-11-08T09:00:02.000Z level=INFO run=abc message=created id=b parentID=root title="t" agent=implementer',
    'timestamp=2026-11-08T09:00:03.000Z level=INFO run=abc message=created id=c parentID=root title="t" agent=reviewer',
    'timestamp=2026-11-08T09:00:04.000Z level=INFO run=abc message="exiting loop" session.id=a',
  ].join("\n");
  const summary = summarizeRuntimeLog(text);
  expect(summary.maxConcurrentSubagents).toBe(3);
  expect(summary.concurrencyExceeded).toBe("yes");
  expect(formatRuntimeLogSummary(summary)).toContain("concurrency_exceeded=yes");
  const truncated = summarizeRuntimeLog(text.replace(/.*exiting loop.*\n?/, ""), true);
  expect(truncated.concurrencyExceeded).toBe("yes");
});

it("reports concurrency as unknown when no session creation was observed", () => {
  const summary = summarizeRuntimeLog("message=loop step=1\n", true);
  expect(summary.maxConcurrentSubagents).toBeNull();
  expect(summary.concurrencyExceeded).toBe("unknown");
  expect(formatRuntimeLogSummary(summary)).toContain("max_concurrent_subagents=unknown");
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

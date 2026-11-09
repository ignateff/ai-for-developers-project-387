import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  formatRuntimeLogSummary,
  summarizeRuntimeLog,
  summarizeRuntimeLogFile,
} from "./opencode-log-summary.ts";
import { summarizeActivity } from "./opencode-activity.ts";

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
    toolPermissions: {
      bash: 1,
      edit: 0,
      read: 0,
      glob: 0,
      grep: 0,
      list: 0,
      todowrite: 0,
      webfetch: 0,
      websearch: 0,
      skill: 0,
      task: 0,
      external_directory: 0,
      question: 0,
      plan_enter: 0,
      plan_exit: 0,
      doom_loop: 0,
      other: 0,
    },
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
  expect(output).toContain("tool_permissions=bash:1");
  expect(output).toContain("tool_duration=unknown");
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
  expect(summary.toolPermissions.task).toBe(3);
  expect(summary.toolPermissions.other).toBe(0);
  expect(summary.completions).toBe(0);
  expect(summary.cancellations).toBe(1);
  expect(summary.errors).toBe(1);
  expect(summary.maxSubagentSeconds).toBe(null);
  expect(summary.maxConcurrentSubagents).toBe(2);
  // `exiting loop` is provisional: a resumed session could still overlap later.
  expect(summary.concurrencyExceeded).toBe("unknown");
  const output = formatRuntimeLogSummary(summary);
  expect(output).toContain("subagent_sessions=2");
  expect(output).toContain("subagent_types=implementer:1,reviewer:1,other:0");
  expect(output).toContain("task_allowed=1");
  expect(output).toContain("task_denied=2");
  expect(output).toContain("tool_permissions=task:3");
  expect(output).toContain("tool_duration=unknown");
  expect(output).toContain("max_subagent_seconds=unknown");
  expect(output).toContain("concurrency_limit=2");
  expect(output).toContain("max_concurrent_subagents=2");
  expect(output).toContain("concurrency_observation=observed_lower_bound");
  expect(output).toContain("concurrency_enforced=no");
  expect(output).toContain("concurrency_exceeded=unknown");
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

it("reports no concurrency breach only when no subagent session started", () => {
  const text = [
    'timestamp=2026-11-08T09:00:00.000Z level=INFO run=abc message=created id=root title="t" agent=build',
    'timestamp=2026-11-08T09:00:01.000Z level=INFO run=abc message="exiting loop" session.id=root',
  ].join("\n");
  const summary = summarizeRuntimeLog(text);
  expect(summary.maxConcurrentSubagents).toBe(0);
  expect(summary.concurrencyExceeded).toBe("no");
});

it("counts a resumed subagent session as active again", () => {
  const text = [
    'timestamp=2026-11-08T09:00:00.000Z level=INFO run=abc message=created id=root title="t" agent=build',
    'timestamp=2026-11-08T09:00:01.000Z level=INFO run=abc message=created id=a parentID=root title="t" agent=implementer',
    'timestamp=2026-11-08T09:00:02.000Z level=INFO run=abc message="exiting loop" session.id=a',
    "timestamp=2026-11-08T09:00:03.000Z level=INFO run=abc message=loop session.id=a step=2",
    'timestamp=2026-11-08T09:00:04.000Z level=INFO run=abc message=created id=b parentID=root title="t" agent=implementer',
    'timestamp=2026-11-08T09:00:05.000Z level=INFO run=abc message=created id=c parentID=root title="t" agent=reviewer',
  ].join("\n");
  const summary = summarizeRuntimeLog(text);
  expect(summary.maxConcurrentSubagents).toBe(3);
  expect(summary.concurrencyExceeded).toBe("yes");
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

it("streams the prepared runtime log and reports a missing file as unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-log-summary-"));
  try {
    expect(await summarizeRuntimeLogFile(join(root, "missing.log"))).toBeNull();
    const directory = join(root, "home", ".local/share/opencode/log");
    await mkdir(directory, { recursive: true });
    const path = join(directory, "opencode.log");
    await writeFile(path, "message=loop step=3\n");
    const log = await summarizeRuntimeLogFile(path);
    expect(log).not.toBeNull();
    expect(formatRuntimeLogSummary(log!.summary)).toContain("loop=1 max_step=3");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("streams across chunks and keeps the last events from the end of the file", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-log-stream-"));
  try {
    const loops = Array.from(
      { length: 200 },
      (_, index) =>
        `timestamp=2026-11-08T09:00:00.000Z level=INFO run=abc message=loop session.id=ses_root step=${index + 1}`,
    ).join("\n");
    const text = [
      loops,
      'timestamp=2026-11-08T09:00:01.000Z level=INFO run=abc message=created id=ses_child parentID=ses_root title="private" agent=implementer',
      'timestamp=2026-11-08T09:00:02.000Z level=INFO run=abc message="exiting loop" session.id=ses_child',
    ].join("\n");
    const path = join(root, "opencode.log");
    await writeFile(path, `${text}\n`);
    const streamed = await summarizeRuntimeLogFile(path, { chunkBytes: 1024 });
    expect(streamed).not.toBeNull();
    expect(streamed!.summary).toEqual(summarizeRuntimeLog(text));
    expect(streamed!.digest).toEqual(summarizeActivity(text));
    expect(streamed!.summary.maxStep).toBe(200);
    expect(streamed!.digest.lastEvents.at(-1)).toContain("event=subagent_ended");
    expect(streamed!.oversizedLines).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("reads the tail when the log exceeds the byte budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-log-tail-"));
  try {
    const filler = Array.from(
      { length: 200 },
      (_, index) =>
        `timestamp=2026-11-08T09:00:00.000Z level=INFO run=abc message=process filler=${index} private="value"`,
    ).join("\n");
    const text = [
      'timestamp=2026-11-08T08:00:00.000Z level=INFO run=abc message=created id=ses_root title="early" agent=build',
      filler,
      'timestamp=2026-11-08T09:59:59.000Z level=INFO run=abc message="exiting loop" session.id=ses_root',
    ].join("\n");
    const path = join(root, "opencode.log");
    await writeFile(path, `${text}\n`);
    const streamed = await summarizeRuntimeLogFile(path, {
      chunkBytes: 512,
      maxLineBytes: 1024,
      maxBytes: 1024,
    });
    expect(streamed).not.toBeNull();
    expect(streamed!.summary.truncated).toBe(true);
    expect(streamed!.digest.lastEvents.at(-1)).toContain("event=loop_end");
    expect(streamed!.digest.lastEvents.join("\n")).not.toContain("private");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("skips oversized lines and counts them without printing their content", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-log-oversize-"));
  try {
    const path = join(root, "opencode.log");
    await writeFile(path, `message=process\n${"x".repeat(5000)}\nmessage=loop step=2\n`);
    const streamed = await summarizeRuntimeLogFile(path, {
      chunkBytes: 1024,
      maxLineBytes: 1024,
    });
    expect(streamed).not.toBeNull();
    expect(streamed!.oversizedLines).toBe(1);
    expect(streamed!.summary.lines).toBe(2);
    expect(streamed!.summary.loop).toBe(1);
    const formatted = formatRuntimeLogSummary(streamed!.summary);
    expect(formatted).not.toContain("xxxx");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

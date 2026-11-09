import { mkdtemp, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  createActivityParser,
  formatActivityDigest,
  formatActivity,
  isCheckFamily,
  sanitizeCommandFamily,
  startActivityWatch,
  summarizeActivity,
} from "./opencode-activity.ts";

const lines = [
  'timestamp=2026-11-08T09:00:00.000Z level=INFO run=abc message=created id=ses_root title="private root prompt" agent=build',
  'timestamp=2026-11-08T09:00:01.000Z level=INFO run=abc message=created id=ses_child parentID=ses_root title="private child prompt" agent=implementer',
  "timestamp=2026-11-08T09:00:02.000Z level=INFO run=abc message=loop session.id=ses_child step=1",
  'timestamp=2026-11-08T09:00:03.000Z level=INFO run=abc message=stream providerID=deepseek modelID=deepseek-flash "session.id"=ses_child agent=build',
  'timestamp=2026-11-08T09:00:04.000Z level=INFO run=abc message=evaluated permission=bash pattern="*" action=allow',
  'timestamp=2026-11-08T09:00:05.000Z level=INFO run=abc message=evaluated permission=bash pattern="mise run check > /tmp/private.log" action=allow',
  "timestamp=2026-11-08T09:00:06.000Z level=INFO run=abc message=evaluated permission=bash pattern=\"git commit -m 'private message'\" action=allow",
  "timestamp=2026-11-08T09:00:07.000Z level=INFO run=abc message=evaluated permission=task pattern=implementer action.action=allow",
  'timestamp=2026-11-08T09:00:08.000Z level=INFO run=abc message=asking id=per_1 permission=external_directory patterns="[\\"/tmp/private-secret\\"]"',
  'timestamp=2026-11-08T09:00:09.000Z level=INFO run=abc message=asking id=per_2 permission=bash patterns="[\\"git push\\"]"',
  'timestamp=2026-11-08T09:00:10.000Z level=INFO run=abc message="shell tool using shell" shell=/bin/bash',
  'timestamp=2026-11-08T09:00:11.000Z level=INFO run=abc message="resolved path" arg="private-arg" resolved="/home/runner/private/file.ts"',
  'timestamp=2026-11-08T09:00:12.000Z level=INFO run=abc message="exiting loop" session.id=ses_child',
  'timestamp=2026-11-08T09:00:13.000Z level=ERROR run=abc message="subtask execution failed" error="private error" prompt="private prompt"',
  "timestamp=2026-11-08T09:00:14.000Z level=INFO run=abc message=ignored value=private-value",
].join("\n");

it("turns the runtime log into allowlisted activity events without raw fields", () => {
  const parser = createActivityParser();
  const events = lines
    .split("\n")
    .map((line) => parser.parseLine(line))
    .filter(Boolean)
    .map((event) => formatActivity(event!));
  expect(events).toHaveLength(14);
  const output = events.join("\n");
  expect(output).toContain("event=session_started agent=build session=1");
  expect(output).toContain("event=subagent_started type=implementer session=2");
  expect(output).toContain("event=loop step=1 session=2");
  expect(output).toContain(
    "event=model_request provider=deepseek model=deepseek-flash agent=build",
  );
  expect(output).toContain("event=tool tool=bash decision=allow");
  expect(output).toContain('event=command family="mise run check" decision=allow');
  expect(output).toContain('event=command family="git commit" decision=allow');
  expect(output).toContain("event=subagent_decision type=implementer decision=allow");
  expect(output).toContain(
    "event=waiting_permission permission=external_directory target=absolute_path",
  );
  expect(output).toContain('event=waiting_permission permission=bash family="git push"');
  expect(output).toContain("event=shell shell=bash");
  expect(output).toContain("event=path target=absolute_path");
  expect(output).toContain("event=subagent_ended session=2");
  expect(output).toContain("event=error details=withheld");
  for (const unsafe of [
    "private",
    "title",
    "prompt",
    "mise run check >",
    "private message",
    "private-secret",
    "/home/runner",
    "private error",
    "private-value",
  ])
    expect(output).not.toContain(unsafe);
});

it("keeps only command families that cannot carry arguments or inline data", () => {
  expect(sanitizeCommandFamily("mise run check > /tmp/private.log")).toBe("mise run check");
  expect(sanitizeCommandFamily("git commit -m 'feat: private'")).toBe("git commit");
  expect(sanitizeCommandFamily("mise run test:e2e")).toBe("mise run");
  expect(sanitizeCommandFamily("echo abc123")).toBe("echo");
  expect(sanitizeCommandFamily("git push origin main")).toBe("git push origin main");
  expect(sanitizeCommandFamily("echo 'private value'")).toBe("echo");
  expect(sanitizeCommandFamily("pnpm exec playwright test")).toBe("pnpm exec playwright test");
  expect(sanitizeCommandFamily("/tmp/private-secret")).toBeUndefined();
  expect(sanitizeCommandFamily("ghp_0123456789abcdef")).toBeUndefined();
  expect(sanitizeCommandFamily("mystery-tool --flag")).toBeUndefined();
  expect(sanitizeCommandFamily("")).toBeUndefined();
  expect(isCheckFamily("mise run check")).toBe(true);
  expect(isCheckFamily("mise run test")).toBe(true);
  expect(isCheckFamily("git commit")).toBe(false);
});

it("summarizes activity counts and keeps only the last safe events", () => {
  const loops = Array.from(
    { length: 30 },
    (_, index) =>
      `timestamp=2026-11-08T09:01:${String(index).padStart(2, "0")}.000Z level=INFO run=abc message=loop session.id=ses_child step=${index + 2}`,
  ).join("\n");
  const digest = summarizeActivity(`${lines}\n${loops}`);
  expect(digest.events).toBe(44);
  expect(digest.commands).toEqual({ "mise run check": 1, "git commit": 1 });
  expect(digest.checks).toEqual({ "mise run check": 1 });
  expect(digest.tools).toEqual({ bash: 1 });
  expect(digest.subagentStarts).toEqual({ implementer: 1 });
  expect(digest.subagentEnds).toBe(1);
  expect(digest.permissionWaits).toBe(2);
  expect(digest.waitingOn).toEqual({ external_directory: 1, bash: 1 });
  expect(digest.errors).toBe(1);
  expect(digest.lastEvents).toHaveLength(20);
  expect(digest.lastEvents.at(-1)).toContain("step=31");
  const formatted = formatActivityDigest(digest).join("\n");
  expect(formatted).toContain("OpenCode activity digest: events=44");
  expect(formatted).toContain("checks=mise run check:1");
  expect(formatted).toContain("subagents_started=implementer:1");
  expect(formatted).toContain("permission_waits=2");
  expect(formatted).toContain("OpenCode activity last events (20):");
  for (const unsafe of ["private", "/home/runner", "private error"])
    expect(formatted).not.toContain(unsafe);
});

async function waitFor(check: () => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((accept) => setTimeout(accept, 10));
  }
  throw new Error("Timed out waiting for activity watcher");
}

it("tails the runtime log live and stops without parsing an incomplete line", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-activity-"));
  try {
    const logPath = join(directory, "opencode.log");
    const first = lines.split("\n").slice(0, 3).join("\n");
    await writeFile(logPath, `${first}\n`);
    const reported: string[] = [];
    const watcher = startActivityWatch({
      logPath,
      report: (line) => reported.push(line),
      pollMs: 10,
    });
    watcher.start();
    await waitFor(() => reported.length >= 3);
    await appendFile(logPath, `${lines.split("\n").slice(3).join("\n")}\n`);
    await waitFor(() => reported.length >= 14);
    await watcher.stop();
    const output = reported.join("\n");
    expect(output).toContain("event=session_started agent=build session=1");
    expect(output).toContain("event=subagent_ended session=2");
    expect(output).not.toContain("private");
    expect(reported.length).toBe(14);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("flushes events appended before stop even when the poll interval has not elapsed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-activity-stop-"));
  try {
    const logPath = join(directory, "opencode.log");
    const initial = lines.split("\n").slice(0, 3).join("\n");
    await writeFile(logPath, `${initial}\n`);
    const reported: string[] = [];
    const watcher = startActivityWatch({
      logPath,
      report: (line) => reported.push(line),
      pollMs: 60_000,
    });
    watcher.start();
    await appendFile(
      logPath,
      'timestamp=2026-11-08T09:00:12.000Z level=INFO run=abc message="exiting loop" session.id=ses_child\n',
    );
    await watcher.stop();
    expect(reported).toHaveLength(4);
    expect(reported.join("\n")).toContain("event=subagent_ended");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

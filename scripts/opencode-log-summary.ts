import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  createActivityAccumulator,
  formatActivityDigest,
  observedTools,
  summarizeActivity,
  type ActivityDigest,
} from "./opencode-activity.ts";

/**
 * Prints only counts of an allowlist of runtime log events. Raw log lines may
 * contain prompts, tool output, credentials or API payloads, so they are never
 * printed: the summary must stay safe to copy into an Actions log.
 *
 * Subagent delegation is summarized from events the pinned runtime actually
 * emits: `evaluated` permission=task (approved type), `created` sessions with a
 * parent (start of a subagent), `exiting loop` (provisional boundary), `cancel`, `errors`
 * and the runtime timestamps. Tool names and individual tool durations are not
 * emitted as a generic event, so they stay `unknown` instead of being guessed.
 */
// Streaming keeps memory bounded per chunk/line. Files above the byte budget are
// read from the tail so the most recent events are never replaced by an old head.
const defaultChunkBytes = 1024 * 1024;
const defaultMaxLineBytes = 1024 * 1024;
const defaultMaxBytes = 256 * 1024 * 1024;

const loopEvent = /(?:^|\s)message=loop(?:\s|$)/;
const processEvent = /(?:^|\s)message=process(?:\s|$)/;
const evaluatedEvent = /(?:^|\s)message=evaluated(?:\s|$)/;
const askingEvent = /(?:^|\s)message=asking(?:\s|$)/;
const shellEvent = /(?:^|\s)message="shell tool using shell"(?:\s|$)/;
const resolvedPathEvent = /(?:^|\s)message="resolved path"(?:\s|$)/;
const step = /(?:^|\s)step=(\d+)(?:\s|$)/;

const approvedSubagents = ["implementer", "reviewer"] as const;

export type RuntimeLogSummary = {
  lines: number;
  truncated: boolean;
  loop: number;
  maxStep: number | null;
  process: number;
  evaluated: number;
  asking: number;
  shell: number;
  paths: number;
  sessions: number;
  subagentSessions: number;
  subagentTypes: Record<(typeof approvedSubagents)[number], number> & { other: number };
  taskAllowed: number;
  taskDenied: number;
  taskAsk: number;
  toolPermissions: Record<(typeof observedTools)[number], number> & { other: number };
  starts: number;
  completions: number;
  cancellations: number;
  errors: number;
  maxSubagentSeconds: number | null;
  maxConcurrentSubagents: number | null;
  concurrencyExceeded: "yes" | "no" | "unknown";
};

function field(line: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}=("(?:[^"\\\\]|\\\\.)*"|\\S*)`).exec(line);
  if (!match) return undefined;
  const value = match[1];
  if (!value.startsWith('"')) return value;
  try {
    return JSON.parse(value) as string;
  } catch {
    return undefined;
  }
}

function timestamp(line: string): number | undefined {
  const value = field(line, "timestamp");
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function emptySummary(truncated = false): RuntimeLogSummary {
  return {
    lines: 0,
    truncated,
    loop: 0,
    maxStep: null,
    process: 0,
    evaluated: 0,
    asking: 0,
    shell: 0,
    paths: 0,
    sessions: 0,
    subagentSessions: 0,
    subagentTypes: { implementer: 0, reviewer: 0, other: 0 },
    taskAllowed: 0,
    taskDenied: 0,
    taskAsk: 0,
    toolPermissions: {
      ...Object.fromEntries(observedTools.map((name) => [name, 0])),
      other: 0,
    } as RuntimeLogSummary["toolPermissions"],
    starts: 0,
    completions: 0,
    cancellations: 0,
    errors: 0,
    maxSubagentSeconds: null,
    maxConcurrentSubagents: null,
    concurrencyExceeded: "unknown",
  };
}

function messageOf(line: string): string | undefined {
  return field(line, "message");
}

export type RuntimeLogAccumulator = {
  addLine: (line: string) => void;
  finish: (truncated?: boolean) => RuntimeLogSummary;
};

/** Stateful variant for streaming large logs without keeping the file in memory. */
export function createRuntimeLogAccumulator(): RuntimeLogAccumulator {
  const summary = emptySummary();
  const sessions = new Map<string, { at: number; subagent: boolean }>();
  const activeSubagents = new Set<string>();
  let sawSessionCreated = false;
  const addLine = (line: string) => {
    if (!line) return;
    summary.lines++;
    const message = messageOf(line);
    if (loopEvent.test(line)) {
      summary.loop++;
      const match = step.exec(line);
      if (match) summary.maxStep = Math.max(summary.maxStep ?? 0, Number(match[1]));
    }
    if (processEvent.test(line)) summary.process++;
    if (evaluatedEvent.test(line)) {
      summary.evaluated++;
      const permission = field(line, "permission");
      if (permission && (observedTools as readonly string[]).includes(permission))
        summary.toolPermissions[permission as (typeof observedTools)[number]]++;
      else if (permission) summary.toolPermissions.other++;
      summarizeTaskDecision(line, summary);
    }
    if (askingEvent.test(line)) summary.asking++;
    if (shellEvent.test(line)) summary.shell++;
    if (resolvedPathEvent.test(line)) summary.paths++;
    if (message === "loop") {
      // A session resumed through task_id logs another loop without a new
      // `created` event; treat it as active again for the lower bound.
      const id = field(line, "session.id") ?? field(line, "sessionID");
      if (id && sessions.get(id)?.subagent && !activeSubagents.has(id)) {
        activeSubagents.add(id);
        summary.maxConcurrentSubagents = Math.max(
          summary.maxConcurrentSubagents ?? 0,
          activeSubagents.size,
        );
      }
    }
    if (message === "created") {
      summary.sessions++;
      sawSessionCreated = true;
      const parent = field(line, "parentID");
      const subagent = !!parent && parent !== "undefined" && parent !== "null";
      const agent = field(line, "agent");
      const id = field(line, "id");
      if (subagent) {
        summary.starts++;
        summary.subagentSessions++;
        if (id) activeSubagents.add(id);
        if (agent === "implementer" || agent === "reviewer") summary.subagentTypes[agent]++;
        else if (agent) summary.subagentTypes.other++;
      }
      const at = timestamp(line);
      if (id && at !== undefined) sessions.set(id, { at, subagent });
      summary.maxConcurrentSubagents = Math.max(
        summary.maxConcurrentSubagents ?? 0,
        activeSubagents.size,
      );
    }
    if (message === "exiting loop" || message === "cancel") {
      if (message === "cancel") summary.cancellations++;
      const id = field(line, "session.id") ?? field(line, "sessionID");
      if (id) activeSubagents.delete(id);
    }
    if (field(line, "level") === "ERROR") summary.errors++;
  };
  return {
    addLine,
    finish(truncated = false): RuntimeLogSummary {
      summary.truncated = truncated;
      if (!sawSessionCreated) {
        summary.maxConcurrentSubagents = null;
        summary.concurrencyExceeded = "unknown";
      } else if ((summary.maxConcurrentSubagents ?? 0) > 2) {
        // An observed breach is reported even if the log tail was lost.
        summary.concurrencyExceeded = "yes";
      } else if (truncated || summary.subagentSessions > 0) {
        // `exiting loop` is only a provisional boundary: a session can be
        // resumed afterwards, so a complete log cannot prove the limit.
        summary.concurrencyExceeded = "unknown";
      } else {
        summary.concurrencyExceeded = "no";
      }
      return summary;
    },
  };
}

export function summarizeRuntimeLog(text: string, truncated = false): RuntimeLogSummary {
  const accumulator = createRuntimeLogAccumulator();
  for (const line of text.split("\n")) accumulator.addLine(line);
  return accumulator.finish(truncated);
}

function summarizeTaskDecision(line: string, summary: RuntimeLogSummary) {
  if (field(line, "permission") !== "task") return;
  const pattern = field(line, "pattern") ?? field(line, "action.pattern") ?? "";
  // The runtime flattens the matched rule; prefer the nested action when present.
  const action = field(line, "action.action") ?? field(line, "action");
  if (action === "allow") summary.taskAllowed++;
  else if (action === "deny") summary.taskDenied++;
  else if (action === "ask") summary.taskAsk++;
}

export function formatRuntimeLogSummary(summary: RuntimeLogSummary): string {
  const permissions = [
    ...observedTools
      .filter((name) => summary.toolPermissions[name] > 0)
      .map((name) => `${name}:${summary.toolPermissions[name]}`),
    ...(summary.toolPermissions.other > 0 ? [`other:${summary.toolPermissions.other}`] : []),
  ].join(",");
  const subagentTypes = [
    ...approvedSubagents.map((name) => `${name}:${summary.subagentTypes[name]}`),
    `other:${summary.subagentTypes.other}`,
  ].join(",");
  return [
    "OpenCode runtime log:",
    "stage=command",
    `loop=${summary.loop}`,
    `max_step=${summary.maxStep ?? "none"}`,
    `process=${summary.process}`,
    `evaluated=${summary.evaluated}`,
    `asking=${summary.asking}`,
    `shell=${summary.shell}`,
    `paths=${summary.paths}`,
    `sessions=${summary.sessions}`,
    `subagent_sessions=${summary.subagentSessions}`,
    `subagent_types=${subagentTypes}`,
    `task_allowed=${summary.taskAllowed}`,
    `task_denied=${summary.taskDenied}`,
    `task_ask=${summary.taskAsk}`,
    `tool_permissions=${permissions || "none"}`,
    "tool_duration=unknown",
    `starts=${summary.starts}`,
    "completions=unknown",
    `cancellations=${summary.cancellations}`,
    `errors=${summary.errors}`,
    "max_subagent_seconds=unknown",
    "concurrency_limit=2",
    `max_concurrent_subagents=${summary.maxConcurrentSubagents ?? "unknown"}`,
    "concurrency_observation=observed_lower_bound",
    "concurrency_enforced=no",
    `concurrency_exceeded=${summary.concurrencyExceeded}`,
    "tool_name=unknown",
    "result=unknown",
    `lines=${summary.lines}`,
    `truncated=${summary.truncated ? "yes" : "no"}`,
  ].join(" ");
}

export type RuntimeLogFileSummary = {
  summary: RuntimeLogSummary;
  digest: ActivityDigest;
  oversizedLines: number;
};

/**
 * Stream the whole runtime log in bounded chunks. The summary and the activity
 * digest see every line, and the digest keeps only the last safe events, so a
 * large file can neither exhaust memory nor hide what happened at the end. For
 * files above `maxBytes` the tail is read instead and `truncated=yes` marks the
 * partial window.
 */
export async function summarizeRuntimeLogFile(
  path: string,
  options: { chunkBytes?: number; maxLineBytes?: number; maxBytes?: number } = {},
): Promise<RuntimeLogFileSummary | null> {
  const chunkBytes = Math.max(1024, options.chunkBytes ?? defaultChunkBytes);
  const maxLineBytes = Math.max(1024, options.maxLineBytes ?? defaultMaxLineBytes);
  const maxBytes = Math.max(maxLineBytes, options.maxBytes ?? defaultMaxBytes);
  let handle;
  let size: number;
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    size = info.size;
    handle = await open(path, "r");
  } catch {
    return null;
  }
  const summary = createRuntimeLogAccumulator();
  const activity = createActivityAccumulator();
  const decoder = new StringDecoder("utf8");
  let position = Math.max(0, size - maxBytes);
  // A tail window starts mid-line; drop that fragment instead of parsing it.
  let skipFirstLine = position > 0;
  let pending = "";
  let dropping = false;
  let oversizedLines = 0;
  const feed = (text: string) => {
    pending += text;
    let index: number;
    while ((index = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, index);
      pending = pending.slice(index + 1);
      if (skipFirstLine) {
        skipFirstLine = false;
        dropping = false;
        continue;
      }
      if (dropping || Buffer.byteLength(line, "utf8") > maxLineBytes) {
        dropping = false;
        oversizedLines++;
        continue;
      }
      summary.addLine(line);
      activity.addLine(line);
    }
    if (Buffer.byteLength(pending, "utf8") > maxLineBytes) {
      pending = "";
      dropping = true;
    }
  };
  try {
    const buffer = Buffer.alloc(chunkBytes);
    while (position < size) {
      const { bytesRead } = await handle.read(buffer, 0, chunkBytes, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      feed(decoder.write(buffer.subarray(0, bytesRead)));
    }
    feed(decoder.end());
    if (!skipFirstLine && (pending || dropping)) {
      if (dropping || Buffer.byteLength(pending, "utf8") > maxLineBytes) oversizedLines++;
      else {
        summary.addLine(pending);
        activity.addLine(pending);
      }
    }
  } finally {
    await handle.close();
  }
  return {
    summary: summary.finish(size > maxBytes),
    digest: activity.digest(),
    oversizedLines,
  };
}

if (import.meta.main) {
  try {
    const directory = process.env.OPENCODE_COMMAND_DIR;
    if (!directory) {
      console.log("OpenCode runtime log: unavailable");
    } else {
      const log = await summarizeRuntimeLogFile(
        join(directory, "home", ".local/share/opencode/log/opencode.log"),
      );
      if (!log) {
        console.log("OpenCode runtime log: unavailable");
      } else {
        console.log(formatRuntimeLogSummary(log.summary));
        console.log(formatActivityDigest(log.digest).join("\n"));
        if (log.oversizedLines > 0)
          console.log(
            `OpenCode runtime log: oversized_lines=${log.oversizedLines} (details withheld)`,
          );
      }
    }
  } catch {
    console.log("OpenCode runtime log: unavailable");
  }
}

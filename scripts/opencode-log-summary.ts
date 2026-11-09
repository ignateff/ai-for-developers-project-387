import { open, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Prints only counts of an allowlist of runtime log events. Raw log lines may
 * contain prompts, tool output, credentials or API payloads, so they are never
 * printed: the summary must stay safe to copy into an Actions log.
 *
 * Subagent delegation is summarized from events the pinned runtime actually
 * emits: `evaluated` permission=task (approved type), `created` sessions with a
 * parent (start of a subagent), `exiting loop` (completion), `cancel`, `errors`
 * and the runtime timestamps. Tool names and individual tool durations are not
 * emitted as a generic event, so they stay `unknown` instead of being guessed.
 */
const maxLogBytes = 32 * 1024 * 1024;

const loopEvent = /(?:^|\s)message=loop(?:\s|$)/;
const processEvent = /(?:^|\s)message=process(?:\s|$)/;
const evaluatedEvent = /(?:^|\s)message=evaluated(?:\s|$)/;
const askingEvent = /(?:^|\s)message=asking(?:\s|$)/;
const shellEvent = /(?:^|\s)message="shell tool using shell"(?:\s|$)/;
const resolvedPathEvent = /(?:^|\s)message="resolved path"(?:\s|$)/;
const step = /(?:^|\s)step=(\d+)(?:\s|$)/;

const approvedSubagents = ["implementer", "reviewer"] as const;

// Permission decisions name a fixed set of tools. Only these fixed names and
// their counts may be printed; anything else is aggregated as `other`.
const observedTools = [
  "bash",
  "edit",
  "read",
  "glob",
  "grep",
  "list",
  "todowrite",
  "webfetch",
  "websearch",
  "skill",
  "task",
  "external_directory",
  "question",
  "plan_enter",
  "plan_exit",
  "doom_loop",
] as const;

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

export function summarizeRuntimeLog(text: string, truncated = false): RuntimeLogSummary {
  const summary = emptySummary(truncated);
  const sessions = new Map<string, { at: number; subagent: boolean }>();
  const activeSubagents = new Set<string>();
  let sawSessionCreated = false;
  for (const line of text.split("\n")) {
    if (!line) continue;
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
      if (message === "exiting loop") {
        const id = field(line, "session.id") ?? field(line, "sessionID");
        const started = id ? sessions.get(id) : undefined;
        if (started) {
          summary.completions++;
          const at = timestamp(line);
          if (started.subagent && at !== undefined) {
            const seconds = Math.max(0, Math.round((at - started.at) / 1000));
            summary.maxSubagentSeconds = Math.max(summary.maxSubagentSeconds ?? 0, seconds);
          }
        }
      } else {
        summary.cancellations++;
      }
      const id = field(line, "session.id") ?? field(line, "sessionID");
      if (id) activeSubagents.delete(id);
    }
    if (field(line, "level") === "ERROR") summary.errors++;
  }
  if (!sawSessionCreated) {
    summary.maxConcurrentSubagents = null;
    summary.concurrencyExceeded = "unknown";
  } else if ((summary.maxConcurrentSubagents ?? 0) > 2) {
    summary.concurrencyExceeded = "yes";
  } else {
    // A truncated log can hide later parallel starts; never claim compliance from partial data.
    summary.concurrencyExceeded = truncated ? "unknown" : "no";
  }
  return summary;
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
    `completions=${summary.completions}`,
    `cancellations=${summary.cancellations}`,
    `errors=${summary.errors}`,
    `max_subagent_seconds=${summary.maxSubagentSeconds ?? "none"}`,
    "concurrency_limit=2",
    `max_concurrent_subagents=${summary.maxConcurrentSubagents ?? "unknown"}`,
    "concurrency_enforced=no",
    `concurrency_exceeded=${summary.concurrencyExceeded}`,
    "tool_name=unknown",
    "result=unknown",
    `lines=${summary.lines}`,
    `truncated=${summary.truncated ? "yes" : "no"}`,
  ].join(" ");
}

export async function readRuntimeLog(
  path: string,
): Promise<{ text: string; truncated: boolean } | null> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    const length = Math.min(info.size, maxLogBytes);
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, 0);
      return {
        text: buffer.subarray(0, bytesRead).toString("utf8"),
        truncated: info.size > length,
      };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

if (import.meta.main) {
  try {
    const directory = process.env.OPENCODE_COMMAND_DIR;
    if (!directory) {
      console.log("OpenCode runtime log: unavailable");
    } else {
      const log = await readRuntimeLog(
        join(directory, "home", ".local/share/opencode/log/opencode.log"),
      );
      console.log(
        log
          ? formatRuntimeLogSummary(summarizeRuntimeLog(log.text, log.truncated))
          : "OpenCode runtime log: unavailable",
      );
    }
  } catch {
    console.log("OpenCode runtime log: unavailable");
  }
}

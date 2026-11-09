import { open, stat } from "node:fs/promises";

/**
 * Safe activity view of the OpenCode runtime log.
 *
 * The runtime log contains prompts, model text, file contents, tool arguments,
 * tool output and possibly credentials. This module never forwards a raw line:
 * it parses the structured `key=value` file log and emits a small allowlist of
 * fixed event names with allowlisted values (tool names, subagent types, step
 * numbers, session ordinals, redacted command families and path categories).
 *
 * The filtering is intentionally best effort and does not make a public Actions
 * log safe for secrets: GitHub masking is not a guarantee. Anything not listed
 * here is dropped instead of being guessed.
 */

export const observedTools = [
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

const subagentTypes = ["implementer", "reviewer"] as const;
const sessionAgents = new Set(["build", "plan", "general", "explore", ...subagentTypes]);
const maxDescriptionTokens = 4;
// Only well-known command words may start a logged command family. An unknown
// first token (for example a pasted secret or an unusual binary) is dropped
// instead of being forwarded to a public Actions log.
const knownCommands = new Set([
  "awk",
  "bash",
  "bun",
  "cargo",
  "cat",
  "cd",
  "chmod",
  "chown",
  "cp",
  "curl",
  "cut",
  "deno",
  "diff",
  "docker",
  "echo",
  "env",
  "export",
  "find",
  "fish",
  "fly",
  "gh",
  "git",
  "go",
  "grep",
  "gzip",
  "head",
  "java",
  "javac",
  "jq",
  "kill",
  "kubectl",
  "ln",
  "lsof",
  "ls",
  "make",
  "mkdir",
  "mise",
  "mv",
  "node",
  "npm",
  "npx",
  "openssl",
  "patch",
  "pkill",
  "playwright",
  "pnpm",
  "podman",
  "poetry",
  "printf",
  "ps",
  "python",
  "python3",
  "pwd",
  "rg",
  "rm",
  "rmdir",
  "rsync",
  "scp",
  "sed",
  "sha256sum",
  "sh",
  "shasum",
  "sleep",
  "sort",
  "source",
  "ssh",
  "ss",
  "sudo",
  "tail",
  "tar",
  "tee",
  "test",
  "time",
  "timeout",
  "touch",
  "tr",
  "true",
  "false",
  "tsc",
  "tsx",
  "unzip",
  "uv",
  "wc",
  "wget",
  "which",
  "xargs",
  "yq",
  "zip",
  "zsh",
]);
const maxLastEvents = 20;
const maxDisplayedFamilies = 8;

type ActivityEventKind =
  | "session_started"
  | "subagent_started"
  | "subagent_ended"
  | "loop"
  | "loop_end"
  | "cancelled"
  | "model_request"
  | "tool"
  | "command"
  | "subagent_decision"
  | "waiting_permission"
  | "shell"
  | "path"
  | "error";

export type ActivityEvent = {
  kind: ActivityEventKind;
  /** Allowlisted key/value pairs; all values are fixed names, numbers or sanitized. */
  fields: Record<string, string>;
};

export type ActivityParser = {
  parseLine: (line: string) => ActivityEvent | undefined;
};

export type ActivityDigest = {
  events: number;
  tools: Record<string, number>;
  commands: Record<string, number>;
  checks: Record<string, number>;
  subagentStarts: Record<string, number>;
  subagentEnds: number;
  permissionWaits: number;
  waitingOn: Record<string, number>;
  errors: number;
  lastEvents: string[];
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

function safeToken(value: string | undefined): string | undefined {
  return value && /^[A-Za-z][A-Za-z0-9_-]*$/.test(value) ? value : undefined;
}

function sessionIdOf(line: string): string | undefined {
  return field(line, "session.id") ?? field(line, "sessionID");
}

function timeOf(line: string): string | undefined {
  const value = field(line, "timestamp");
  if (!value) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  return new Date(parsed).toISOString().slice(0, 19);
}

/**
 * Keep only leading plain words of a shell permission pattern (for example
 * `mise run check` from `mise run check > /tmp/log`). Quoted values, paths,
 * URLs, flags and any shell syntax stop the summary, so arguments and inline
 * data never reach the log.
 */
export function sanitizeCommandFamily(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const tokens: string[] = [];
  for (const token of value.trim().split(/\s+/)) {
    const allowed =
      tokens.length === 0
        ? /^[A-Za-z][A-Za-z0-9_-]*$/.test(token) && knownCommands.has(token)
        : /^[a-z][a-z-]{0,20}$/.test(token);
    if (!allowed) break;
    tokens.push(token);
    if (tokens.length === maxDescriptionTokens) break;
  }
  return tokens.length > 0 ? tokens.join(" ") : undefined;
}

function firstPattern(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const array = /^\[(.*)\]$/.exec(value.trim());
  const first = array ? array[1].split(",")[0] : value;
  return first?.trim().replace(/^"|"$/g, "");
}

function sanitizePatternFamily(value: string | undefined): string | undefined {
  return sanitizeCommandFamily(firstPattern(value));
}

export function isCheckFamily(family: string | undefined): boolean {
  if (!family) return false;
  return /^(mise run (check|test|lint|format|typecheck|build)|pnpm (run )?(check|test|lint|format|typecheck|build)|vitest|playwright test|node --test)/.test(
    family,
  );
}

function pathCategory(value: string | undefined): string {
  if (!value) return "unknown";
  const raw = value.trim().replace(/^"|"$/g, "");
  const items = raw.startsWith("[")
    ? raw
        .slice(1, -1)
        .split(",")
        .map((part) => part.trim().replace(/^"|"$/g, ""))
    : [raw];
  const categories = items.map((item) => {
    if (item === "*" || item === "") return "wildcard";
    if (item.startsWith("/")) return "absolute_path";
    if (item === "undefined" || item === "null") return "unknown";
    return "relative_path";
  });
  return [...new Set(categories)].sort().join(",");
}

function formatValue(value: string): string {
  return /\s/.test(value) ? JSON.stringify(value) : value;
}

function formatEvent(event: ActivityEvent): string {
  return `OpenCode activity: event=${event.kind} ${Object.entries(event.fields)
    .map(([key, value]) => `${key}=${formatValue(value)}`)
    .join(" ")}`;
}

export function createActivityParser(): ActivityParser {
  const sessionOrdinals = new Map<string, number>();
  const sessionTypes = new Map<string, string>();
  let nextSession = 0;

  const ordinalFor = (id: string): number => {
    const existing = sessionOrdinals.get(id);
    if (existing !== undefined) return existing;
    nextSession += 1;
    sessionOrdinals.set(id, nextSession);
    return nextSession;
  };

  return {
    parseLine(line: string): ActivityEvent | undefined {
      const message = field(line, "message");
      if (!message) return undefined;
      const time = timeOf(line);
      const base = (kind: ActivityEventKind, fields: Record<string, string>): ActivityEvent => ({
        kind,
        fields: { ...fields, ...(time ? { time } : {}) },
      });
      if (message === "created") {
        const id = field(line, "id");
        if (!id) return undefined;
        const ordinal = ordinalFor(id);
        const parent = field(line, "parentID");
        const subagent = Boolean(parent && parent !== "undefined" && parent !== "null");
        const agent = safeToken(field(line, "agent")) ?? "other";
        sessionTypes.set(id, agent);
        if (subagent)
          return base("subagent_started", {
            type: subagentTypes.find((name) => name === agent) ?? "other",
            session: String(ordinal),
          });
        return base("session_started", {
          agent: sessionAgents.has(agent) ? agent : "other",
          session: String(ordinal),
        });
      }
      if (message === "loop") {
        const step = field(line, "step");
        const id = sessionIdOf(line);
        if (!step || !/^\d+$/.test(step)) return undefined;
        return base("loop", {
          step,
          ...(id ? { session: String(ordinalFor(id)) } : {}),
        });
      }
      if (message === "exiting loop") {
        const id = sessionIdOf(line);
        if (!id) return undefined;
        const agent = sessionTypes.get(id);
        const subagent = subagentTypes.some((name) => name === agent);
        return base(subagent ? "subagent_ended" : "loop_end", { session: String(ordinalFor(id)) });
      }
      if (message === "cancel") {
        const id = sessionIdOf(line);
        return base("cancelled", id ? { session: String(ordinalFor(id)) } : {});
      }
      if (message === "stream") {
        const provider = safeToken(field(line, "providerID")) ?? "other";
        const model = safeToken(field(line, "modelID")) ?? "other";
        const agent = safeToken(field(line, "agent")) ?? "other";
        return base("model_request", {
          provider,
          model,
          agent: sessionAgents.has(agent) ? agent : "other",
        });
      }
      if (message === "evaluated") {
        const permission = field(line, "permission");
        const pattern = field(line, "pattern") ?? field(line, "action.pattern");
        const action = field(line, "action.action") ?? field(line, "action");
        if (!permission || !["allow", "deny", "ask"].includes(action ?? "")) return undefined;
        if (permission === "task") {
          const type = subagentTypes.find((name) => name === pattern) ?? "other";
          return base("subagent_decision", { type, decision: action! });
        }
        if (permission === "bash") {
          const family = sanitizeCommandFamily(pattern);
          if (family) return base("command", { family, decision: action! });
        }
        const tool = (observedTools as readonly string[]).includes(permission)
          ? permission
          : "other";
        return base("tool", { tool, decision: action! });
      }
      if (message === "asking") {
        const permission = (observedTools as readonly string[]).includes(
          field(line, "permission") ?? "",
        )
          ? field(line, "permission")!
          : "other";
        const patterns = field(line, "patterns");
        if (permission === "bash") {
          const family = sanitizePatternFamily(patterns);
          return base("waiting_permission", {
            permission,
            ...(family ? { family } : { target: "unknown" }),
          });
        }
        return base("waiting_permission", { permission, target: pathCategory(patterns) });
      }
      if (message === "shell tool using shell") {
        const shell = safeToken((field(line, "shell") ?? "").split("/").pop());
        return base("shell", {
          shell: shell && ["bash", "sh", "zsh", "fish"].includes(shell) ? shell : "other",
        });
      }
      if (message === "resolved path") {
        return base("path", {
          target: pathCategory(field(line, "resolved") ?? field(line, "arg")),
        });
      }
      if (field(line, "level") === "ERROR") return base("error", { details: "withheld" });
      return undefined;
    },
  };
}

export function formatActivity(event: ActivityEvent): string {
  return formatEvent(event);
}

export function summarizeActivity(text: string): ActivityDigest {
  const digest: ActivityDigest = {
    events: 0,
    tools: {},
    commands: {},
    checks: {},
    subagentStarts: {},
    subagentEnds: 0,
    permissionWaits: 0,
    waitingOn: {},
    errors: 0,
    lastEvents: [],
  };
  const parser = createActivityParser();
  for (const line of text.split("\n")) {
    if (!line) continue;
    const event = parser.parseLine(line);
    if (!event) continue;
    digest.events++;
    switch (event.kind) {
      case "tool": {
        const tool = event.fields.tool ?? "other";
        digest.tools[tool] = (digest.tools[tool] ?? 0) + 1;
        break;
      }
      case "command": {
        const family = event.fields.family ?? "unknown";
        digest.commands[family] = (digest.commands[family] ?? 0) + 1;
        if (isCheckFamily(family)) digest.checks[family] = (digest.checks[family] ?? 0) + 1;
        break;
      }
      case "subagent_started": {
        const type = event.fields.type ?? "other";
        digest.subagentStarts[type] = (digest.subagentStarts[type] ?? 0) + 1;
        break;
      }
      case "subagent_decision":
      case "subagent_ended":
        break;
      case "waiting_permission": {
        digest.permissionWaits++;
        const permission = event.fields.permission ?? "other";
        digest.waitingOn[permission] = (digest.waitingOn[permission] ?? 0) + 1;
        break;
      }
      case "error":
        digest.errors++;
        break;
      default:
        break;
    }
    if (event.kind === "subagent_ended") digest.subagentEnds++;
    digest.lastEvents.push(formatEvent(event));
    if (digest.lastEvents.length > maxLastEvents) digest.lastEvents.shift();
  }
  return digest;
}

function sortedCounts(counts: Record<string, number>, limit = Infinity): string {
  const entries = Object.entries(counts).sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  );
  const shown = entries.slice(0, limit).map(([name, count]) => `${name}:${count}`);
  const hidden = entries.slice(limit).reduce((sum, [, count]) => sum + count, 0);
  if (hidden > 0) shown.push(`other:${hidden}`);
  return shown.length > 0 ? shown.join(",") : "none";
}

export function formatActivityDigest(digest: ActivityDigest): string[] {
  const summary = [
    "OpenCode activity digest:",
    `events=${digest.events}`,
    `tools=${sortedCounts(digest.tools)}`,
    `command_families=${sortedCounts(digest.commands, maxDisplayedFamilies)}`,
    `checks=${sortedCounts(digest.checks)}`,
    `subagents_started=${sortedCounts(digest.subagentStarts)}`,
    `subagent_ends=${digest.subagentEnds}`,
    `permission_waits=${digest.permissionWaits}`,
    `waiting_on=${sortedCounts(digest.waitingOn)}`,
    `errors=${digest.errors}`,
  ].join(" ");
  const last = digest.lastEvents.length;
  return [
    summary,
    last > 0
      ? `OpenCode activity last events (${last}): ${digest.lastEvents.join(" | ")}`
      : "OpenCode activity last events: none",
  ];
}

export type ActivityWatcher = {
  start: () => void;
  stop: () => Promise<void>;
};

/**
 * Tail the runtime log while the handler runs and report safe activity lines
 * live. The file is written asynchronously, so a final read in stop() flushes
 * everything that is already on disk; the post-run digest covers any remainder.
 */
export function startActivityWatch(options: {
  logPath: string;
  report?: (line: string) => void;
  pollMs?: number;
}): ActivityWatcher {
  const report = options.report ?? console.log;
  const pollMs = options.pollMs ?? 500;
  const parser = createActivityParser();
  let offset = 0;
  let partial = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let reading = false;
  let inFlight: Promise<void> | undefined;

  const parseCompleteLines = (chunk: string) => {
    const buffer = partial + chunk;
    const lines = buffer.split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      const event = parser.parseLine(line);
      if (event) report(formatEvent(event));
    }
  };

  const readOnce = async (): Promise<void> => {
    try {
      const info = await stat(options.logPath);
      if (!info.isFile()) return;
      if (info.size < offset) {
        offset = 0;
        partial = "";
      }
      if (info.size === offset) return;
      const length = info.size - offset;
      const handle = await open(options.logPath, "r");
      try {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        offset += bytesRead;
        parseCompleteLines(buffer.subarray(0, bytesRead).toString("utf8"));
      } finally {
        await handle.close();
      }
    } catch {
      // Missing or transiently unreadable log: the post-run digest reports it.
    }
  };

  const poll = async (): Promise<void> => {
    if (stopped || reading) return;
    reading = true;
    inFlight = readOnce().finally(() => {
      reading = false;
      inFlight = undefined;
    });
    await inFlight;
  };

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      void poll().finally(schedule);
    }, pollMs);
    timer.unref();
  };

  return {
    start() {
      schedule();
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      // Let a read that was already in progress finish, then force one last
      // read regardless of the stopped flag. Guarding the final read with
      // `stopped` would silently drop events from the last poll interval.
      if (inFlight) await inFlight;
      await readOnce();
      // An incomplete line may be cut mid-value; the post-run digest parses the
      // complete file instead of guessing from a partial event.
      partial = "";
    },
  };
}

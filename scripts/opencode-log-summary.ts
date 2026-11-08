import { open, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Prints only counts of an allowlist of runtime log events. Raw log lines may
 * contain prompts, tool output, credentials or API payloads, so they are never
 * printed: the summary must stay safe to copy into an Actions log.
 */
const maxLogBytes = 32 * 1024 * 1024;

const loopEvent = /(?:^|\s)message=loop(?:\s|$)/;
const processEvent = /(?:^|\s)message=process(?:\s|$)/;
const evaluatedEvent = /(?:^|\s)message=evaluated(?:\s|$)/;
const askingEvent = /(?:^|\s)message=asking(?:\s|$)/;
const shellEvent = /(?:^|\s)message="shell tool using shell"(?:\s|$)/;
const resolvedPathEvent = /(?:^|\s)message="resolved path"(?:\s|$)/;
const step = /(?:^|\s)step=(\d+)(?:\s|$)/;

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
};

export function summarizeRuntimeLog(text: string, truncated = false): RuntimeLogSummary {
  const summary: RuntimeLogSummary = {
    lines: 0,
    truncated,
    loop: 0,
    maxStep: null,
    process: 0,
    evaluated: 0,
    asking: 0,
    shell: 0,
    paths: 0,
  };
  for (const line of text.split("\n")) {
    if (!line) continue;
    summary.lines++;
    if (loopEvent.test(line)) {
      summary.loop++;
      const match = step.exec(line);
      if (match) summary.maxStep = Math.max(summary.maxStep ?? 0, Number(match[1]));
    }
    if (processEvent.test(line)) summary.process++;
    if (evaluatedEvent.test(line)) summary.evaluated++;
    if (askingEvent.test(line)) summary.asking++;
    if (shellEvent.test(line)) summary.shell++;
    if (resolvedPathEvent.test(line)) summary.paths++;
  }
  return summary;
}

export function formatRuntimeLogSummary(summary: RuntimeLogSummary): string {
  return [
    "OpenCode runtime log:",
    `loop=${summary.loop}`,
    `max_step=${summary.maxStep ?? "none"}`,
    `process=${summary.process}`,
    `evaluated=${summary.evaluated}`,
    `asking=${summary.asking}`,
    `shell=${summary.shell}`,
    `paths=${summary.paths}`,
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

import { spawn } from "node:child_process";

export class ProcessFailure extends Error {
  readonly reason: "start" | "abort" | "timeout" | "exit" | "output";
  constructor(reason: "start" | "abort" | "timeout" | "exit" | "output") {
    super(`Process ${reason}`);
    this.reason = reason;
  }
}

/** Kill the whole process group, including descendants retaining stdout/stderr. */
export function runIsolatedProcess(
  file: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    timeout: number;
    maxBuffer: number;
  },
): Promise<string> {
  if (options.signal?.aborted) return Promise.reject(new ProcessFailure("abort"));
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let reason: ProcessFailure["reason"] | undefined;
    let size = 0;
    const chunks: Buffer[] = [];
    const kill = (why: ProcessFailure["reason"]) => {
      reason ??= why;
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL");
        }
      }
    };
    const abort = () => kill("abort");
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const timer = setTimeout(() => kill("timeout"), options.timeout);
    const receive = (data: Buffer, stdout: boolean) => {
      size += data.length;
      if (size > options.maxBuffer) kill("output");
      else if (stdout) chunks.push(data);
    };
    child.stdout.on("data", (data: Buffer) => receive(data, true));
    child.stderr.on("data", (data: Buffer) => receive(data, false));
    child.on("error", () => {
      reason ??= "start";
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (reason || code !== 0) reject(new ProcessFailure(reason ?? "exit"));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

import { execFile } from "node:child_process";

export function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {},
): Promise<string> {
  const timeout = options.timeout ?? 15000;
  return new Promise((resolve, reject) => {
    // A test command may ignore SIGTERM; keep its deadline independent of that handler.
    execFile(
      command,
      args,
      { ...options, timeout, killSignal: "SIGKILL", encoding: "utf8" },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout);
          return;
        }
        const reason =
          error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
            ? "output exceeded maxBuffer"
            : error.killed
              ? `timed out after ${timeout}ms`
              : `exit code ${error.code}`;
        reject(
          new Error(
            `${command} ${args.join(" ")} (${options.cwd ?? process.cwd()}): ${reason}\n${stdout}\n${stderr}`,
            { cause: error },
          ),
        );
      },
    );
  });
}

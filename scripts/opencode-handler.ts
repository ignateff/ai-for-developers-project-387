import { spawn } from "node:child_process";

const phases = new Map([
  ["Configuring git...", "configuring Git"],
  ["Checking out new branch...", "checking out branch"],
  ["Checking out local branch...", "checking out internal PR"],
  ["Fetching prompt data for issue...", "reading issue"],
  ["Fetching prompt data for PR...", "reading PR"],
  ["Sending message to opencode...", "processing request"],
  ["Checking if branch is dirty...", "checking changes"],
  ["Pushing to new branch...", "publishing branch"],
  ["Pushing to local branch...", "updating internal PR"],
  ["Creating pull request...", "creating PR"],
  ["Creating comment...", "publishing response"],
]);

/** Call only after verifying the binary. Upstream diagnostics are untrusted:
 * App credentials are created inside that process, unknown to the parent.
 * Relay only exact fixed status messages, never raw output or error annotations.
 */
export async function runGitHubHandler(options: {
  binary: string;
  workspace: string;
  env: NodeJS.ProcessEnv;
  report?: (line: string) => void;
}): Promise<void> {
  const report = options.report ?? console.log;
  await new Promise<void>((accept, reject) => {
    const child = spawn(options.binary, ["github", "run"], {
      cwd: options.workspace,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let partial = "";
    let dropping = false;
    let cancelled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    child.stdout.on("data", (chunk: Buffer) => {
      const pieces = chunk.toString("utf8").split("\n");
      for (let index = 0; index < pieces.length; index++) {
        const newline = index < pieces.length - 1;
        if (!dropping) {
          partial += pieces[index];
          if (partial.length > 4096) {
            partial = "";
            dropping = true;
          } else if (newline) {
            const phase = phases.get(partial);
            if (phase) report(`OpenCode: ${phase}`);
          }
        }
        if (newline) {
          partial = "";
          dropping = false;
        }
      }
    });
    child.stderr.resume();
    const signalGroup = (signal: NodeJS.Signals) => {
      if (child.pid) {
        try {
          process.kill(-child.pid, signal);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH")
            reject(new Error("OpenCode signal forwarding failed"));
        }
      }
    };
    const cancel = (signal: NodeJS.Signals) => {
      cancelled = true;
      signalGroup(signal);
      killTimer ??= setTimeout(() => signalGroup("SIGKILL"), 5000).unref();
    };
    const terminate = () => cancel("SIGTERM");
    const interrupt = () => cancel("SIGINT");
    process.on("SIGTERM", terminate);
    process.on("SIGINT", interrupt);
    const cleanup = () => {
      process.off("SIGTERM", terminate);
      process.off("SIGINT", interrupt);
      clearTimeout(killTimer);
    };
    child.once("error", () => {
      cleanup();
      reject(new Error("OpenCode GitHub handler could not start"));
    });
    child.once("close", (code, signal) => {
      cleanup();
      if (code === 0 && !signal && !cancelled) {
        report("OpenCode: upstream handler completed");
        accept();
      } else
        reject(new Error("OpenCode GitHub handler failed or was cancelled; fix is not confirmed"));
    });
  });
}

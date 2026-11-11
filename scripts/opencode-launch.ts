import { spawn } from "node:child_process";
import { safeOpenCodeError } from "./opencode-error.ts";
import { openCodeModelFromEnvironment, openCodeProviderCredentials } from "./opencode-model.ts";

export type LaunchPlan = {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  model: string;
};

/**
 * Build the environment for a direct OpenCode invocation. The configured model
 * and its provider credential are forwarded; every other provider credential is
 * removed. Arguments stay an array, so the model value cannot become shell text.
 */
export function createLaunchPlan(options: {
  executable: string;
  args: string[];
  base?: NodeJS.ProcessEnv;
}): LaunchPlan {
  if (!options.executable || /[\r\n\0]/.test(options.executable))
    throw new Error("OpenCode executable path is invalid");
  const base = options.base ?? process.env;
  const { model, credential } = openCodeModelFromEnvironment(base);
  const env: NodeJS.ProcessEnv = { ...base, MODEL: model, OPENCODE_MODEL: model };
  for (const name of openCodeProviderCredentials) if (name !== credential) delete env[name];
  const args = [...options.args];
  // `opencode run` selects its model explicitly; `github run` reads MODEL.
  if (args[0] === "run" && !args.includes("--model")) args.splice(1, 0, "--model", model);
  return { executable: options.executable, args, env, model };
}

/** Launch without a shell and preserve the child exit status. */
export async function launchOpenCode(options: {
  executable: string;
  args: string[];
  base?: NodeJS.ProcessEnv;
}): Promise<number> {
  const plan = createLaunchPlan(options);
  console.log(`OpenCode model: ${plan.model}`);
  return await new Promise((accept, reject) => {
    const child = spawn(plan.executable, plan.args, { stdio: "inherit", env: plan.env });
    child.once("error", () => reject(new Error("OpenCode process could not start")));
    child.once("close", (code, signal) => accept(code ?? (signal ? 1 : 0)));
  });
}

if (import.meta.main) {
  try {
    const [executable, ...args] = process.argv.slice(2);
    if (!executable || args.length === 0)
      throw new Error("OpenCode launcher requires an executable and arguments");
    process.exitCode = await launchOpenCode({ executable, args });
  } catch (error) {
    console.error(safeOpenCodeError(error, "OpenCode launch failed"));
    process.exitCode = 1;
  }
}

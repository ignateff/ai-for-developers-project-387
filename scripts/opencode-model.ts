import { safeOpenCodeError } from "./opencode-error.ts";

/**
 * The single source of truth for the model used by working OpenCode workflows.
 *
 * Repository variable OPENCODE_MODEL overrides it. Workflows pass the variable
 * through the environment; they must not contain a fallback model literal.
 * Values are never interpolated into shell commands.
 */
export const defaultOpenCodeModel = "opencode-go/deepseek-v4.1-flash";
export const openCodeModelVariable = "OPENCODE_MODEL";

const providerCredentials = {
  "opencode-go": "OPENCODE_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
} as const;

/** Provider credentials an OpenCode runtime could use. Only one is forwarded. */
export const openCodeProviderCredentials: readonly string[] = Object.values(providerCredentials);

const supportedProviders = Object.keys(providerCredentials);
const modelPattern = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;

export function resolveOpenCodeModel(value: string | undefined): string {
  const model = value?.trim() ?? "";
  if (!model) return defaultOpenCodeModel;
  if (model.length > 100 || !modelPattern.test(model))
    throw new Error(
      "OpenCode model configuration is invalid; set OPENCODE_MODEL to provider/model using lowercase letters, digits, '.', '_' or '-'.",
    );
  return model;
}

export function credentialVariable(model: string): string {
  const provider = model.split("/", 1)[0] ?? "";
  const credential = providerCredentials[provider as keyof typeof providerCredentials];
  if (!credential)
    throw new Error(
      `OpenCode model provider is unsupported; supported providers are ${supportedProviders.join(", ")}.`,
    );
  return credential;
}

/** Resolve the model and the one credential that the provider requires. */
export function openCodeModelFromEnvironment(env: NodeJS.ProcessEnv) {
  const model = resolveOpenCodeModel(env[openCodeModelVariable]);
  const credential = credentialVariable(model);
  const apiKey = env[credential];
  if (!apiKey)
    throw new Error(
      `OpenCode model credentials are missing; ${credential} is required for the configured provider.`,
    );
  return { model, credential, apiKey };
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 3 || process.argv[2] !== "check")
      throw new Error("OpenCode model check requires the check argument");
    const { model } = openCodeModelFromEnvironment(process.env);
    console.log(`OpenCode model: ${model}`);
  } catch (error) {
    console.error(safeOpenCodeError(error, "OpenCode model configuration failed"));
    process.exitCode = 1;
  }
}

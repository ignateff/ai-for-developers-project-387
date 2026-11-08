/**
 * Only fixed diagnostics whose message starts with "OpenCode " may be printed.
 * Callers must not interpolate paths, URLs, tokens, response bodies or other
 * runtime details into those messages.
 */
export function safeOpenCodeError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.startsWith("OpenCode ") ? error.message : fallback;
}

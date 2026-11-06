import { classifyEvent, evaluateBudget } from "./actions-budget.ts";

type History = Parameters<typeof evaluateBudget>[0];

/** Read-only observation, not a reservation or permission to start a runtime. */
export async function inspectExperiment(
  options: Omit<History, "request"> & {
    event: string;
    payload: unknown;
    trusted: boolean;
    kind: "full" | "model" | "publication";
  },
) {
  if (options.kind === "publication")
    return { decision: "infra" as const, reason: "publication-only" };
  if (options.kind !== "full" && options.kind !== "model")
    return { decision: "infra" as const, reason: "invalid-invocation" };
  const binding = classifyEvent(options.event, options.payload);
  if (!binding) return { decision: "infra" as const, reason: "not-a-candidate" };
  if (options.trusted !== true) return { decision: "infra" as const, reason: "untrusted" };
  return { ...(await evaluateBudget({ ...options, request: binding })), binding };
}

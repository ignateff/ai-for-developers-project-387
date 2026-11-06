import { classifyEvent, evaluateBudget } from "./actions-budget.ts";

type HistoryOptions = Parameters<typeof evaluateBudget>[0];

/** Observation only: caller-provided events and history bindings are not authenticated. */
export async function inspectCandidate(
  options: Omit<HistoryOptions, "request"> & { event: string; payload: unknown },
) {
  const binding = classifyEvent(options.event, options.payload);
  if (!binding) return { decision: "infra" as const, reason: "not-a-candidate" };
  const result = await evaluateBudget({ ...options, request: binding });
  return { ...result, binding };
}

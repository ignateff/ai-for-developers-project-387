import { classifyEvent } from "./actions-budget.ts";
import { runHarness } from "./actions-harness.ts";
import { authorizeComment } from "./opencode-trust.ts";

/** Production decision is deliberately not derived from the unverified candidate. */
export async function inspectGate(options: {
  repository: string;
  owner: string;
  token: string;
  workflowId: number;
  boundaryRunId: number;
  event: string;
  payload: unknown;
  fetch?: typeof fetch;
}) {
  const binding = classifyEvent(options.event, options.payload);
  if (!binding) return { decision: "skip" as const, reason: "not-a-candidate" };
  if (binding.budget === "review")
    return { decision: "infra" as const, reason: "review-trust-unverified" };
  const trust = await authorizeComment({
    eventName: options.event,
    event: options.payload,
    repository: options.repository,
    owner: options.owner,
    token: options.token,
    fetch: options.fetch,
  });
  if (!trust.allowed || trust.number !== binding.pr) {
    if (["github-error", "invalid-input", "invalid-event"].includes(trust.reason))
      return { decision: "infra" as const, reason: "trust-unavailable" };
    return { decision: "skip" as const, reason: "untrusted" };
  }
  const candidate = await runHarness({ ...options, trusted: true });
  if (candidate.decision === "infra") return candidate;
  if (candidate.decision === "skip")
    return { decision: "infra" as const, reason: "classification-mismatch" };
  return {
    decision: "infra" as const,
    reason: "admission-properties-unverified",
    binding,
    hypothetical:
      candidate.decision === "admit" ? ("would-admit" as const) : ("limit-exhausted" as const),
    used: candidate.used,
    evidence: candidate.evidence,
  };
}

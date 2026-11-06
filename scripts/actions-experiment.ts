import { classifyEvent } from "./actions-budget.ts";

// This is a fixture protocol, not a GitHub API or a production authorization gate.
type RecordEntry = { runId: number; pr: number; budget: "command" | "review"; invocation: string };
type Request = {
  runId: number;
  kind: "full" | "model" | "publication";
  invocation?: string;
  event: string;
  payload: unknown;
  trusted: boolean;
  runtime?: "success" | "prepare-fails" | "cancelled" | "timeout";
};

/** An in-memory fake HTTP server. Its atomicity and persistence are fixture assumptions. */
export function createExperiment() {
  const records: RecordEntry[] = [];
  const github: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== "https://fixture.invalid") return new Response(null, { status: 404 });
    if (url.pathname === "/history" && !init?.method) return Response.json(records);
    if (url.pathname !== "/admit" || init?.method !== "POST")
      return new Response(null, { status: 404 });
    const candidate = JSON.parse(String(init.body)) as RecordEntry;
    // There is no await between checking and recording: atomic only in this fixture process.
    if (records.some((item) => item.invocation === candidate.invocation))
      return Response.json({ decision: "infra", reason: "duplicate-invocation" });
    const used = records.filter(
      (item) => item.pr === candidate.pr && item.budget === candidate.budget,
    ).length;
    if (used >= 3) return Response.json({ decision: "denied", reason: "limit-exhausted", used });
    records.push(candidate);
    return Response.json({
      decision: "admitted",
      used: used + 1,
      evidence: `fixture://admissions/${records.length}`,
    });
  };

  return createExperimentClient(github);
}

/** Only connect this client to a local fixture, never to GitHub or a model runtime. */
export function createExperimentClient(github: typeof fetch) {
  let sequence = 0;
  return {
    async dispatch(request: Request) {
      if (request.kind === "publication")
        return { decision: "skipped", reason: "publication-only" };
      const binding = classifyEvent(request.event, request.payload);
      if (!binding) return { decision: "skipped", reason: "not-a-candidate" };
      if (!request.trusted) return { decision: "denied", reason: "untrusted" };
      if (!Number.isSafeInteger(request.runId) || request.runId < 1)
        return { decision: "infra", reason: "invalid-run" };
      try {
        const response = await github("https://fixture.invalid/admit", {
          method: "POST",
          body: JSON.stringify({
            ...binding,
            runId: request.runId,
            invocation: request.invocation ?? `fixture-${++sequence}`,
          }),
        });
        if (!response.ok) throw new Error();
        const result = (await response.json()) as {
          decision: string;
          reason?: string;
          used?: number;
          evidence?: string;
        };
        if (!["admitted", "denied", "infra"].includes(result.decision)) throw new Error();
        if (
          result.decision === "admitted" &&
          (!Number.isSafeInteger(result.used) ||
            !/^fixture:\/\/admissions\/\d+$/.test(result.evidence ?? ""))
        )
          throw new Error();
        return result.decision === "admitted"
          ? { ...result, outcome: request.runtime ?? "success" }
          : result;
      } catch {
        return { decision: "infra", reason: "fixture-api-unavailable" };
      }
    },
    async history(): Promise<RecordEntry[]> {
      return (await (await github("https://fixture.invalid/history")).json()) as RecordEntry[];
    },
  };
}

import { runHarness } from "./actions-harness.ts";

// Fixture-only: no network and no credentials, even if invoked in Actions.
try {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const fixture = JSON.parse(input);
  const responses = fixture.responses as Record<string, unknown>;
  const mock: typeof fetch = async (url) => {
    const parsed = new URL(String(url));
    const key = parsed.pathname + parsed.search;
    if (parsed.origin !== "https://api.github.com" || !Object.hasOwn(responses, key))
      return new Response(null, { status: 404 });
    return Response.json(responses[key]);
  };
  const result = await runHarness({ ...fixture.options, token: "fixture", fetch: mock });
  console.log(JSON.stringify(result));
} catch {
  console.log(JSON.stringify({ decision: "infra", reason: "invalid-fixture" }));
  process.exitCode = 1;
}

import { expect, test } from "vitest";
import { createBudgetWorkflow } from "./opencode-budget-workflow";
import { publishReview } from "./opencode-review-publish";

test("publication-only rerun publishes a saved review without budget or model calls", async () => {
  const comments: string[] = [];
  let models = 0;
  const api: typeof fetch = async (input, init) => {
    if (String(input).includes("/pulls/"))
      return Response.json({ number: 7, head: { sha: "a".repeat(40) } });
    if (init?.method === "POST") {
      comments.push(JSON.parse(String(init.body)).body);
      return Response.json({ id: 1 }, { status: 201 });
    }
    return Response.json(comments.map((body) => ({ body, user: { id: 42 } })));
  };
  const publish = () =>
    publishReview({
      fetch: api,
      repository: "owner/repo",
      token: "token",
      authorId: 42,
      number: 7,
      sha: "a".repeat(40),
      artifact: "review-123-1",
      report: {
        summary: "No confirmed defects",
        limitations: ["Requirements unavailable"],
        findings: [],
      },
    });
  const run = createBudgetWorkflow({
    fetch: api,
    prepare: async () => {
      throw Error();
    },
    model: async () => {
      models++;
    },
    publish,
  });
  const options = {
    kind: "review" as const,
    eventName: "pull_request",
    event: {},
    repository: "owner/repo",
    owner: "owner",
    token: "token",
    authorId: 42,
    actionsUrl: "",
    publicationOnly: true,
  };
  expect((await run(options)).status).toBe("published");
  expect((await run(options)).status).toBe("published");
  expect(comments).toHaveLength(1);
  expect(comments[0]).toContain("No confirmed defects");
  expect(comments[0]).toContain("a".repeat(40));
  expect(models).toBe(0);
});

test("publication refuses a stale head and does not call the model", async () => {
  let posts = 0;
  const api: typeof fetch = async (_input, init) => {
    if (init?.method === "POST") posts++;
    return Response.json({ number: 7, head: { sha: "b".repeat(40) } });
  };
  const publish = () =>
    publishReview({
      fetch: api,
      repository: "owner/repo",
      token: "token",
      authorId: 42,
      number: 7,
      sha: "a".repeat(40),
      artifact: "review-123-1",
      report: { summary: "No confirmed defects", limitations: [], findings: [] },
    });
  const run = createBudgetWorkflow({
    fetch: api,
    prepare: async () => {},
    model: async () => {
      throw Error();
    },
    publish,
  });
  expect(
    (
      await run({
        kind: "review",
        eventName: "pull_request",
        event: {},
        repository: "owner/repo",
        owner: "owner",
        token: "token",
        authorId: 42,
        actionsUrl: "",
        publicationOnly: true,
      })
    ).status,
  ).toBe("infra");
  expect(posts).toBe(0);
});

import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parse } from "yaml";

const source = readFileSync(".github/workflows/agentic-triage.md", "utf8");
const workflow = parse(source.split("---")[1]);
const job = workflow.jobs.eligibility;

it("runs bounded triage and restricts publication to the target issue", () => {
  expect(workflow.on.issues.types).toEqual(["opened"]);
  expect(workflow.on.workflow_dispatch.inputs.issue_number.required).toBe(true);
  expect(workflow.concurrency.queue).toBe("max");
  expect(workflow.tools.bash).toBe(false);
  expect(workflow.tools.edit).toBe(false);
  expect(workflow["safe-outputs"]["add-comment"]).toMatchObject({ max: 1, "pull-requests": false });
  expect(source).toContain("> *Сгенерировано ИИ в ходе триажа.*");
  expect(source).toContain("Напиши по-русски");
});

it("checks live labels and author permission, failing closed on API errors", async () => {
  const script = job.steps.find((step: { id?: string }) => step.id === "check").with.script;
  const run = new (Object.getPrototypeOf(async function () {}).constructor)(
    "github",
    "context",
    "core",
    script,
  );
  const context = { repo: { owner: "owner", repo: "repo" } };
  const previous = process.env.ISSUE_NUMBER;
  process.env.ISSUE_NUMBER = "1";
  const issue = { user: { login: "author", type: "User" }, labels: [] as string[] };
  const github = {
    rest: {
      issues: { get: async () => ({ data: issue }) },
      repos: { getCollaboratorPermissionLevel: async () => ({ data: { permission: "write" } }) },
    },
  };
  const core = { warning: () => {} };
  expect(await run(github, context, core)).toBe(true);
  issue.labels.push("ready-for-agent");
  expect(await run(github, context, core)).toBe(false);
  issue.labels = [];
  issue.user.type = "Bot";
  expect(await run(github, context, core)).toBe(false);
  issue.user.type = "User";
  github.rest.repos.getCollaboratorPermissionLevel = async () => ({ data: { permission: "read" } });
  expect(await run(github, context, core)).toBe(false);
  github.rest.issues.get = async () => {
    throw new Error("API unavailable");
  };
  expect(await run(github, context, core)).toBe(false);
  if (previous === undefined) delete process.env.ISSUE_NUMBER;
  else process.env.ISSUE_NUMBER = previous;
});

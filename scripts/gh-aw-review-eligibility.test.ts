import { describe, expect, test } from "vitest";
import { evaluateEligibility, type EligibilityOptions } from "./gh-aw-review-eligibility";

const sha = "a".repeat(40);
const base = "b".repeat(40);
const repository = "ignateff/ai-for-developers-project-387";

const pull = (overrides: Record<string, unknown> = {}) => ({
  number: 7,
  state: "open",
  draft: false,
  user: { login: "author", type: "User", id: 1 },
  base: { sha: base, repo: { id: 10, full_name: repository } },
  head: { sha, repo: { id: 10, full_name: repository } },
  ...overrides,
});

const api =
  (pr: unknown, permission = "write", requests: string[] = []): typeof fetch =>
  async (input) => {
    const url = new URL(String(input));
    requests.push(url.pathname);
    if (url.pathname.endsWith("/pulls/7")) return Response.json(pr);
    if (url.pathname.includes("/collaborators/")) return Response.json({ permission });
    return new Response(null, { status: 404 });
  };

const options = (apiFetch: typeof fetch): EligibilityOptions => ({
  fetch: apiFetch,
  repository,
  owner: "ignateff",
  token: "token",
  number: 7,
});

describe("gh-aw review eligibility", () => {
  test("admits an open internal PR from a current write collaborator", async () => {
    const requests: string[] = [];
    const decision = await evaluateEligibility(options(api(pull(), "write", requests)));
    expect(decision).toEqual({
      allowed: true,
      reason: "allowed",
      number: 7,
      headSha: sha,
      baseSha: base,
    });
    expect(requests).toContain(`/repos/${repository}/collaborators/author/permission`);
  });

  test.each([
    ["owner", { login: "ignateff", type: "User", id: 2 }, "read", true],
    ["admin", { login: "author", type: "User", id: 1 }, "admin", true],
    ["maintain", { login: "author", type: "User", id: 1 }, "maintain", true],
    ["write", { login: "author", type: "User", id: 1 }, "write", true],
    ["read", { login: "author", type: "User", id: 1 }, "read", false],
    ["bot allowlisted", { login: "opencode-agent[bot]", type: "Bot", id: 219766164 }, "read", true],
    [
      "release bot allowlisted",
      { login: "calendar-release-ignateff-bot[bot]", type: "Bot", id: 351107404 },
      "read",
      true,
    ],
    ["unknown bot", { login: "other[bot]", type: "Bot", id: 44 }, "read", false],
  ])("checks the current PR author: %s", async (_label, user, permission, admitted) => {
    const decision = await evaluateEligibility(options(api(pull({ user }), permission)));
    expect(decision.allowed).toBe(admitted);
    expect(decision.reason).toBe(admitted ? "allowed" : "untrusted-author");
  });

  test.each([
    ["draft", pull({ draft: true }), "draft"],
    ["closed", pull({ state: "closed" }), "closed"],
    [
      "fork",
      pull({
        head: { sha, repo: { id: 11, full_name: "someone/fork" } },
      }),
      "fork",
    ],
    [
      "other repository",
      pull({
        base: { sha: base, repo: { id: 10, full_name: "other/repo" } },
        head: { sha, repo: { id: 10, full_name: "other/repo" } },
      }),
      "fork",
    ],
    [
      "missing head",
      pull({ head: { sha: "nope", repo: { id: 10, full_name: repository } } }),
      "invalid-pr",
    ],
    ["missing number", pull({ number: 8 }), "invalid-pr"],
  ])("skips %s without needing a model", async (_label, pr, reason) => {
    const decision = await evaluateEligibility(options(api(pr)));
    expect(decision).toEqual({ allowed: false, reason });
  });

  test("fails closed on trust API errors", async () => {
    const decision = await evaluateEligibility(
      options(async () => {
        throw new Error("unavailable");
      }),
    );
    expect(decision).toEqual({ allowed: false, reason: "infra" });
  });

  test("rejects invalid input before any request", async () => {
    let called = false;
    const apiFetch: typeof fetch = async () => {
      called = true;
      return Response.json(pull());
    };
    for (const bad of ["0", "-1", "7.5", "abc"]) {
      const decision = await evaluateEligibility({ ...options(apiFetch), number: Number(bad) });
      expect(decision).toEqual({ allowed: false, reason: "invalid-input" });
    }
    expect(called).toBe(false);
  });
});

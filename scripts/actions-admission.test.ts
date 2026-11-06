import { describe, expect, it, vi } from "vitest";
import { inspectAdmissionAttempt } from "./actions-admission.ts";

describe("Actions admission evidence contour", () => {
  it("finds a successful admission marker but refuses to authorize without proven history and serialization", async () => {
    const github = vi.fn(async (_url: string | URL | Request) =>
      Response.json({
        total_count: 1,
        jobs: [
          {
            id: 10,
            name: "model",
            steps: [{ name: "admission", status: "completed", conclusion: "success" }],
          },
        ],
      }),
    );
    const result = await inspectAdmissionAttempt({
      repository: "owner/repo",
      runId: 42,
      attempt: 2,
      token: "secret",
      fetch: github,
    });
    expect(result).toEqual({
      decision: "infra",
      reason: "admission-properties-unverified",
      marker: "present",
      evidence: "https://github.com/owner/repo/actions/runs/42/attempts/2",
    });
    expect(github.mock.calls[0][0]).toBe(
      "https://api.github.com/repos/owner/repo/actions/runs/42/attempts/2/jobs?per_page=100&page=1",
    );
  });

  it("reads every jobs page before interpreting the marker", async () => {
    const github = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("page=1")) {
        return Response.json({
          total_count: 101,
          jobs: Array.from({ length: 100 }, (_, id) => ({ id: id + 1, name: "other", steps: [] })),
        });
      }
      return Response.json({
        total_count: 101,
        jobs: [
          {
            id: 101,
            name: "model",
            steps: [{ name: "admission", status: "completed", conclusion: "success" }],
          },
        ],
      });
    });
    const result = await inspectAdmissionAttempt({
      repository: "owner/repo",
      runId: 42,
      attempt: 1,
      token: "secret",
      fetch: github,
    });
    expect(result.marker).toBe("present");
    expect(result.decision).toBe("infra");
    expect(github).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["HTTP failure", () => new Response("secret", { status: 403 })],
    ["missing jobs", () => Response.json({ total_count: 1 })],
    ["truncated jobs", () => Response.json({ total_count: 2, jobs: [] })],
    ["missing steps", () => Response.json({ total_count: 1, jobs: [{ id: 1, name: "model" }] })],
  ])("fails closed on %s without exposing API contents", async (_label, response) => {
    const result = await inspectAdmissionAttempt({
      repository: "owner/repo",
      runId: 42,
      attempt: 1,
      token: "secret",
      fetch: async () => response(),
    });
    expect(result).toEqual({ decision: "infra", reason: "github-history-unavailable" });
  });
});

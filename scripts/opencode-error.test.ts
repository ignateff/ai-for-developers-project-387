import { expect, it } from "vitest";
import { safeOpenCodeError } from "./opencode-error.ts";

it("returns fixed OpenCode reasons unchanged", () => {
  expect(
    safeOpenCodeError(
      new Error(
        "OpenCode archive download failed after 3 attempt(s) (network, HTTP, size limit, or timeout)",
      ),
      "fallback",
    ),
  ).toBe(
    "OpenCode archive download failed after 3 attempt(s) (network, HTTP, size limit, or timeout)",
  );
  expect(safeOpenCodeError(new Error("OpenCode archive checksum mismatch"), "fallback")).toBe(
    "OpenCode archive checksum mismatch",
  );
});

it("replaces anything that is not a fixed OpenCode reason", () => {
  expect(safeOpenCodeError(new Error("private-network-error /private/path"), "fallback")).toBe(
    "fallback",
  );
  expect(safeOpenCodeError(new Error("token=secret"), "fallback")).toBe("fallback");
  expect(safeOpenCodeError("private string", "fallback")).toBe("fallback");
  expect(safeOpenCodeError(undefined, "fallback")).toBe("fallback");
});

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = resolve("scripts/check-contract-http.mjs");
let directory: string;

function fixture(path: string, source: string) {
  const file = join(directory, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, source);
  return file;
}

function check(...files: string[]) {
  return spawnSync(process.execPath, [script, ...files], { cwd: directory, encoding: "utf8" });
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "contract-http-"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("check-contract-http", () => {
  it.each(["app.inject({})", 'app["inject"]({})'])("rejects %s with a location", (call) => {
    const file = fixture("example.contract.test.ts", `const app = {};\n${call};\n`);
    const result = check(file);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${file}:2: contract tests must use real HTTP, not inject()`);
  });

  it("accepts real HTTP and ignores non-call references to inject", () => {
    const file = fixture(
      "contract.test.ts",
      'const inject = "inject";\nawait fetch("http://localhost:3000");\n',
    );
    const result = check(file);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("recursively discovers contract tests and ignores other files", () => {
    fixture("apps/api/src/nested/allowed.contract.test.ts", 'await fetch("http://localhost");');
    fixture("apps/api/src/ignored.test.ts", "app.inject({});");
    expect(check().status).toBe(0);

    fixture("apps/api/src/nested/deeper/contract.test.ts", "app.inject({});");
    const result = check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("apps/api/src/nested/deeper/contract.test.ts:1:");
    expect(result.stderr).not.toContain("ignored.test.ts");
  });

  it("does not detect an aliased method or a helper that calls inject", () => {
    const file = fixture(
      "contract.test.ts",
      'import { request } from "./helper";\nconst send = app.inject;\nsend({});\nrequest();',
    );
    fixture("helper.ts", "export const request = () => app.inject({});");
    const result = check(file);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });
});

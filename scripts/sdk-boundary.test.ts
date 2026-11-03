import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const config = resolve(".oxlintrc.json");
const oxlint = resolve("node_modules/oxlint/bin/oxlint");
let directory: string;

function fixture(path: string, source: string) {
  const file = join(directory, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, source);
  return path;
}

function lint(...files: string[]) {
  // GitHub's reporter omits diagnostic help, including the SDK guidance checked below.
  return spawnSync(process.execPath, [oxlint, "--format", "json", "--deny-warnings", ...files], {
    cwd: directory,
    encoding: "utf8",
  });
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "sdk-boundary-"));
  copyFileSync(config, join(directory, ".oxlintrc.json"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("frontend SDK boundary", () => {
  it("pins JSON diagnostics so CI does not omit the custom SDK guidance", () => {
    const file = fixture("apps/web/src/client.ts", "import 'axios';");
    const result = lint(file);

    expect(result.status, result.stdout + result.stderr).toBe(1);
    const { diagnostics } = JSON.parse(result.stdout);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: "eslint(no-restricted-imports)",
      filename: file,
    });
    expect(JSON.stringify(diagnostics[0])).toContain("Use the generated SDK");
  });

  it("rejects direct and global-object network primitives throughout production frontend", () => {
    const sources = [
      ...["", "window.", "globalThis.", "self."].flatMap((prefix) => [
        `${prefix}fetch('/api/bookings');`,
        `new ${prefix}XMLHttpRequest();`,
        `new ${prefix}WebSocket('ws://localhost');`,
        `new ${prefix}EventSource('/api/events');`,
      ]),
      "window['fetch']('/api/bookings');",
      "navigator.sendBeacon('/api/bookings');",
      "window.navigator.sendBeacon('/api/bookings');",
    ];
    const files = sources.map((source, index) =>
      fixture(`apps/web/src/nested/feature/network-${index}.tsx`, source),
    );
    const result = lint(...files);

    expect(result.status, result.stdout + result.stderr).toBe(1);
    for (const file of files) expect(result.stdout).toContain(file);
    expect(result.stdout).toContain("Use the generated SDK");
  });

  it("rejects alternative HTTP-client imports and their subpaths", () => {
    const clients = ["axios", "ky", "ofetch", "node-fetch", "cross-fetch", "undici", "superagent"];
    const files = clients.flatMap((client, index) => [
      fixture(`apps/web/src/client-${index}.ts`, `import '${client}';`),
      fixture(`apps/web/src/nested/client-${index}.ts`, `import '${client}/subpath';`),
    ]);
    const result = lint(...files);

    expect(result.status, result.stdout + result.stderr).toBe(1);
    for (const file of files) expect(result.stdout).toContain(file);
    expect(result.stdout).toContain("Use the generated SDK");
  });

  it("allows generated SDK calls without enumerating API operations", () => {
    const file = fixture(
      "apps/web/src/nested/client.ts",
      "import { meetingTypesList, createBooking, upcomingEvents } from '../../../../../generated/sdk/client';\nexport const operations = { meetingTypesList, createBooking, upcomingEvents };\nmeetingTypesList();\nupcomingEvents();",
    );
    const result = lint(file);

    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it("keeps frontend tests, the generated SDK and server code outside the network restriction", () => {
    const files = [
      "apps/web/src/client.test.ts",
      "apps/web/src/nested/client.test.tsx",
      "apps/web/src/nested/client.spec.js",
      "apps/web/src/nested/client.spec.jsx",
      "apps/api/src/client.ts",
      "generated/sdk/client.ts",
    ].map((path) => fixture(path, "fetch('/api/health');\nnew XMLHttpRequest();"));
    const result = lint(...files);

    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it("still lints test files instead of globally ignoring them", () => {
    const file = fixture("apps/web/src/client.test.ts", "debugger;");
    const result = lint(file);

    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toContain("no-debugger");
  });
});

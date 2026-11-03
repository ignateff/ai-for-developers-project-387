import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const script = fileURLToPath(new URL("docker-smoke.ts", import.meta.url));

// The command-boundary tests must not depend on files in the developer's real
// checkout: the smoke runs against a minimal controlled fixture instead.
function fixtureCheckout(): string {
  const root = mkdtempSync(join(tmpdir(), "smoke-checkout-"));
  execFileSync("git", ["init", "-q", root]);
  writeFileSync(join(root, ".dockerignore"), ".git\n");
  writeFileSync(join(root, "Dockerfile"), "FROM scratch\n");
  writeFileSync(join(root, "version.txt"), "9.9.9\n");
  execFileSync("git", ["add", "."], { cwd: root });
  return root;
}

const fakeDocker = `#!${process.execPath}
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(args) + '\\n');
const state = JSON.parse(fs.readFileSync(process.env.FAKE_STATE, 'utf8'));
const save = () => fs.writeFileSync(process.env.FAKE_STATE, JSON.stringify(state));
const scenario = process.env.FAKE_SCENARIO;
if (args[0] === 'info') process.exit(0);
if (args[0] === 'build') {
  const label = args[args.indexOf('--label') + 1];
  state.owner = label?.split('=')[1];
  state.image = args[args.indexOf('-t') + 1];
  save();
  if (scenario === 'signal') { process.kill(process.ppid, 'SIGTERM'); setInterval(() => {}, 1000); return; }
  if (scenario === 'uncertain-build') process.exit(1);
  process.exit(0);
}
if (args[0] === 'create') {
  const label = args[args.indexOf('--label') + 1];
  state.owner = label?.split('=')[1];
  if (scenario === 'late-create') {
    const [file, name, owner] = [process.env.FAKE_STATE, args[args.indexOf('--name') + 1], state.owner];
    const delayMs = Number(process.env.FAKE_DELAY_MS);
    const child = spawn(process.execPath, ['-e',
      'setTimeout(() => { const fs = require("node:fs"); const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); s.container = process.argv[2]; s.owner = process.argv[3]; fs.writeFileSync(process.argv[1], JSON.stringify(s)); }, ' + delayMs + ');',
      file, name, owner], { detached: true, stdio: 'ignore' });
    child.unref();
  } else {
    state.container = args[args.indexOf('--name') + 1];
    save();
  }
  process.exit(1);
}
if ((args[0] === 'image' && args[1] === 'inspect') || (args[0] === 'container' && args[1] === 'inspect')) {
  const current = JSON.parse(fs.readFileSync(process.env.FAKE_STATE, 'utf8'));
  if (current.inspectFails) { process.stderr.write('Cannot connect to Docker daemon'); process.exit(7); }
  const exists = args[0] === 'image' ? current.image : current.container;
  if (!exists) process.exit(1);
  const owner = scenario === 'foreign' ? 'someone-else' : current.owner;
  console.log(JSON.stringify({ Id: (args[0] === 'image' ? 'sha256:' : '') + 'b'.repeat(64), Config: { Labels: { 'calendar.smoke.owner': owner } } }));
  process.exit(0);
}
if (args[0] === 'rm') { const current = JSON.parse(fs.readFileSync(process.env.FAKE_STATE, 'utf8')); delete current.container; fs.writeFileSync(process.env.FAKE_STATE, JSON.stringify(current)); process.exit(0); }
if (args[0] === 'image' && args[1] === 'rm') { const current = JSON.parse(fs.readFileSync(process.env.FAKE_STATE, 'utf8')); delete current.image; fs.writeFileSync(process.env.FAKE_STATE, JSON.stringify(current)); process.exit(0); }
process.exit(1);
`;

function harness(scenario: string, extra: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "smoke-fake-docker-"));
  const checkout = fixtureCheckout();
  const log = join(directory, "calls");
  const state = join(directory, "state.json");
  const recoveryDir = join(directory, "recoveries");
  writeFileSync(state, "{}");
  writeFileSync(join(directory, "docker"), fakeDocker, { mode: 0o755 });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${directory}:${process.env.PATH}`,
    FAKE_LOG: log,
    FAKE_STATE: state,
    FAKE_SCENARIO: scenario,
    CALENDAR_SMOKE_ROOT: checkout,
    CALENDAR_SMOKE_RECOVERY_DIR: recoveryDir,
    CALENDAR_SMOKE_RECONCILE_MS: extra.CALENDAR_SMOKE_RECONCILE_MS ?? "5000",
    ...extra,
  };
  delete env.CALENDAR_SMOKE_ALLOWLIST;
  const run = (args: string[] = []) =>
    spawnSync(process.execPath, [script, ...args], { env, encoding: "utf8", timeout: 60_000 });
  const calls = () =>
    (existsSync(log) ? readFileSync(log, "utf8") : "")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
  const cleanup = () => {
    rmSync(directory, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
  };
  return { run, calls, state, recoveryDir, checkout, log, cleanup };
}

it("fails clearly rather than skipping when Docker is unavailable", () => {
  const directory = mkdtempSync(join(tmpdir(), "smoke-no-docker-"));
  try {
    writeFileSync(join(directory, "docker"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: directory };
    delete env.CALENDAR_SMOKE_ALLOWLIST;
    delete env.CALENDAR_SMOKE_ROOT;
    const result = spawnSync(process.execPath, [script], {
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Docker is unavailable");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("stops before building on unapproved working-copy inputs without reading them", () => {
  const { run, checkout, log, cleanup } = harness("uncertain-build");
  try {
    writeFileSync(join(checkout, "service-account.json"), "not-for-output");
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/unapproved/i);
    expect(readFileSync(log, "utf8")).not.toContain('"build"');
  } finally {
    cleanup();
  }
});

it.each(["signal", "uncertain-build", "uncertain-create", "foreign"])(
  "cleans only verified owned resources after %s",
  (scenario) => {
    const { run, calls, state, recoveryDir, cleanup } = harness(scenario);
    try {
      const result = run();
      expect(result.status).not.toBe(0);
      const log = calls();
      if (scenario === "foreign") {
        expect(result.stderr).toContain("left untouched");
        expect(
          log.some((args) => args[0] === "rm" || (args[0] === "image" && args[1] === "rm")),
        ).toBe(false);
        expect(existsSync(recoveryDir)).toBe(true);
        return;
      }
      expect(result.stderr).toContain(
        scenario === "signal" ? "outcome may be unknown" : "did not complete cleanly",
      );
      expect(log.some((args) => args[0] === "image" && args[1] === "rm")).toBe(true);
      expect(JSON.parse(readFileSync(state, "utf8"))).not.toHaveProperty("image");
      if (scenario === "uncertain-create") {
        expect(log.some((args) => args[0] === "rm")).toBe(true);
        expect(JSON.parse(readFileSync(state, "utf8"))).not.toHaveProperty("container");
      }
      expect(existsSync(recoveryDir)).toBe(false);
    } finally {
      cleanup();
    }
  },
);

it("reconciles a container created late by the daemon and removes it", () => {
  const { run, calls, state, recoveryDir, cleanup } = harness("late-create", {
    FAKE_DELAY_MS: "500",
    CALENDAR_SMOKE_RECONCILE_MS: "8000",
  });
  try {
    const result = run();
    expect(result.status).not.toBe(0);
    expect(calls().some((args) => args[0] === "rm")).toBe(true);
    expect(JSON.parse(readFileSync(state, "utf8"))).not.toHaveProperty("container");
    expect(existsSync(recoveryDir)).toBe(false);
  } finally {
    cleanup();
  }
});

it("records unresolved late resources and the recover command removes only owned ones", () => {
  const { run, calls, state, recoveryDir, cleanup } = harness("late-create", {
    FAKE_DELAY_MS: "2500",
    CALENDAR_SMOKE_RECONCILE_MS: "300",
  });
  try {
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unresolved Docker resources");
    const records = readdirSync(recoveryDir).filter((name) => name.endsWith(".json"));
    expect(records).toHaveLength(1);
    const recordPath = join(recoveryDir, records[0]);
    expect(result.stderr).toContain(`recover ${recordPath}`);
    // Wait for the fake daemon's late completion, then recover by record.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !JSON.parse(readFileSync(state, "utf8")).container) {
      spawnSync("sleep", ["0.1"]);
    }
    expect(JSON.parse(readFileSync(state, "utf8")).container).toBeTruthy();
    const recovered = run(["recover", recordPath]);
    expect(recovered.status).toBe(0);
    expect(JSON.parse(readFileSync(state, "utf8"))).not.toHaveProperty("container");
    expect(existsSync(recordPath)).toBe(false);
    expect(calls().some((args) => args[0] === "rm")).toBe(true);
  } finally {
    cleanup();
  }
});

it("preserves an absent resource for recovery after the daemon completes late", () => {
  const { run, state, recoveryDir, cleanup } = harness("uncertain-build");
  try {
    const runId = "a".repeat(24);
    const container = `calendar-smoke-${runId}`;
    mkdirSync(recoveryDir);
    const path = join(recoveryDir, `${runId}.json`);
    const saved = JSON.stringify({
      runId,
      owner: runId,
      label: "calendar.smoke.owner",
      resources: [{ kind: "container", name: container }],
    });
    writeFileSync(path, saved);
    const early = run(["recover", path]);
    expect(early.status).not.toBe(0);
    expect(early.stderr).toContain("unresolved");
    expect(readFileSync(path, "utf8")).toBe(saved);
    // The daemon finishes only after the first recovery attempt has returned.
    writeFileSync(state, JSON.stringify({ owner: runId, container }));
    const recovered = run(["recover", path]);
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(existsSync(path)).toBe(false);
    expect(JSON.parse(readFileSync(state, "utf8"))).not.toHaveProperty("container");
  } finally {
    cleanup();
  }
});

it("rejects an invalid recovery record without touching resources", () => {
  const { run, calls, recoveryDir, cleanup } = harness("uncertain-build");
  try {
    const path = join(recoveryDir, "bad.json");
    mkdirSync(recoveryDir, { recursive: true });
    writeFileSync(path, JSON.stringify({ runId: "x", resources: [] }));
    const result = run(["recover", path]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Invalid smoke recovery record");
    expect(calls().some((args) => args[0] === "rm")).toBe(false);
  } finally {
    cleanup();
  }
});

it("retains the recovery record while the Docker daemon is unavailable", () => {
  const { run, calls, state, recoveryDir, cleanup } = harness("uncertain-build");
  try {
    const runId = "a".repeat(24);
    mkdirSync(recoveryDir);
    const path = join(recoveryDir, `${runId}.json`);
    const saved = JSON.stringify({
      runId,
      owner: runId,
      label: "calendar.smoke.owner",
      resources: [{ kind: "container", name: `calendar-smoke-${runId}` }],
    });
    writeFileSync(path, saved);
    writeFileSync(state, JSON.stringify({ inspectFails: true }));
    const result = run(["recover", path]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unresolved");
    expect(readFileSync(path, "utf8")).toBe(saved);
    expect(calls().some((args) => args[0] === "rm")).toBe(false);
  } finally {
    cleanup();
  }
});

it("remembers confirmed cleanup when another recorded resource is still unresolved", () => {
  const { run, state, recoveryDir, cleanup } = harness("uncertain-build");
  try {
    const runId = "a".repeat(24);
    const container = `calendar-smoke-${runId}`;
    mkdirSync(recoveryDir);
    const path = join(recoveryDir, `${runId}.json`);
    writeFileSync(
      path,
      JSON.stringify({
        runId,
        owner: runId,
        label: "calendar.smoke.owner",
        resources: [
          { kind: "image", name: `calendar-smoke:${runId}` },
          { kind: "container", name: container },
        ],
      }),
    );
    writeFileSync(state, JSON.stringify({ owner: runId, image: `calendar-smoke:${runId}` }));
    const partial = run(["recover", path]);
    expect(partial.status).not.toBe(0);
    expect(JSON.parse(readFileSync(path, "utf8")).resources).toEqual([
      { kind: "container", name: container },
    ]);
    writeFileSync(state, JSON.stringify({ owner: runId, container }));
    const recovered = run(["recover", path]);
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(existsSync(path)).toBe(false);
  } finally {
    cleanup();
  }
});

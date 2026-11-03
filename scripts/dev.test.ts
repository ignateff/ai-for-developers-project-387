import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { runCommand } from "./test-command";

const root = resolve(import.meta.dirname, "..");
const checkouts: string[] = [];
// Keep the macOS Unix socket path short, and isolate both registry and state.
let sandbox: string;
let preserveDiagnostics = false;
const isolatedEnv: NodeJS.ProcessEnv = {
  ...process.env,
  PITCHFORK_PROXY_ENABLE: "false",
  PITCHFORK_WEB_AUTO_START: "false",
  PITCHFORK_API_AUTO_START: "false",
};
for (const name of [
  "PORT",
  "WEB_PORT",
  "API_PROXY_TARGET",
  "PITCHFORK_WEB_PORT",
  "PITCHFORK_CONFIG",
]) {
  delete isolatedEnv[name];
}
beforeAll(() => {
  sandbox = mkdtempSync(join(homedir(), ".calendar-dev-test-"));
  Object.assign(isolatedEnv, {
    MISE_STATE_DIR: join(sandbox, "mise"),
    PITCHFORK_STATE_DIR: join(sandbox, "pf"),
    PITCHFORK_CONFIG_DIR: join(sandbox, "config"),
    PITCHFORK_LOGS_DIR: join(sandbox, "logs"),
  });
});
beforeEach(({ onTestFailed }) => {
  onTestFailed(() => {
    preserveDiagnostics = true;
  });
});

function mise(args: string[], cwd: string, extraEnv: NodeJS.ProcessEnv = {}, timeout = 60000) {
  return runCommand("mise", args, {
    cwd,
    env: { ...isolatedEnv, MISE_TRUSTED_CONFIG_PATHS: cwd, ...extraEnv },
    timeout,
  });
}

async function start(cwd: string, extraEnv: NodeJS.ProcessEnv = {}) {
  try {
    return await mise(["run", "dev"], cwd, extraEnv);
  } catch (error) {
    const diagnostics = await mise(["daemons", "ls", "--json"], cwd, {}, 5000).catch(String);
    throw new Error(`${String(error)}\nDaemon state: ${diagnostics}\nLogs: ${sandbox}/logs`, {
      cause: error,
    });
  }
}
function makeCheckout() {
  const checkout = mkdtempSync(join(tmpdir(), "calendar-dev-test-"));
  checkouts.push(checkout);
  cpSync(root, checkout, {
    recursive: true,
    filter: (path) => !/(^|\/)(node_modules|\.git|calendar\.sqlite)(\/|$)/.test(path),
  });
  for (const dir of ["", "apps/api", "apps/web"]) {
    symlinkSync(join(root, dir, "node_modules"), join(checkout, dir, "node_modules"), "dir");
  }
  return checkout;
}
let checkout: string | undefined;

afterAll(async () => {
  const errors: unknown[] = [];
  for (const dir of checkouts) {
    try {
      let daemons = JSON.parse(await mise(["daemons", "ls", "--json"], dir, {}, 5000));
      if (daemons.some((daemon: { status: string }) => daemon.status !== "available")) {
        await mise(["daemons", "stop"], dir, {}, 5000);
        daemons = JSON.parse(await mise(["daemons", "ls", "--json"], dir, {}, 5000));
      }
      expect(daemons).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "api", pid: null }),
          expect.objectContaining({ name: "web", pid: null }),
        ]),
      );
      expect(
        daemons.every(
          (daemon: { status: string; pid: number | null }) =>
            ["stopped", "available", "errored"].includes(daemon.status) && daemon.pid === null,
        ),
      ).toBe(true);
      if (!preserveDiagnostics) rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length)
    throw new AggregateError(errors, `Cleanup failed; preserved state: ${sandbox}`);
  if (checkouts.length) await runCommand("pitchfork", ["supervisor", "stop"], { env: isolatedEnv });
  if (preserveDiagnostics) console.error(`Dev test diagnostics preserved at ${sandbox}`);
  else rmSync(sandbox, { recursive: true, force: true });
}, 180000);

test("starts a web server when the default web port is occupied", async () => {
  checkout = makeCheckout();
  const blocker = createServer();
  const ownsBlocker = await new Promise<boolean>((resolve, reject) => {
    blocker.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") resolve(false);
      else reject(error);
    });
    blocker.listen(5173, "127.0.0.1", () => resolve(true));
  });
  try {
    const output = await start(checkout);
    const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    expect(url).toBeDefined();
    expect(url).not.toBe("http://127.0.0.1:5173");
    expect(await (await fetch(`${url}/api/health`)).json()).toEqual({ status: "ok" });
    const again = await start(checkout);
    expect(again).toContain(url);
  } finally {
    if (ownsBlocker) blocker.close();
  }
}, 80000);

test("cleans up the newly started API when the web server fails", async () => {
  const failing = makeCheckout();
  const config = join(failing, "mise.toml");
  writeFileSync(
    config,
    readFileSync(config, "utf8").replace(/run = '''target=.*?strictPort'''/, 'run = "exit 1"'),
  );
  await expect(start(failing)).rejects.toThrow(/: exit code 1\n/);
  const daemons = JSON.parse(await mise(["daemons", "ls", "--json"], failing));
  expect(daemons.filter((daemon: { status: string }) => daemon.status === "running")).toEqual([]);
}, 80000);

test("uses an explicitly requested web port", async () => {
  const explicit = makeCheckout();
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("No port");
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const output = await start(explicit, { WEB_PORT: String(address.port) });
  expect(output).toContain(`http://127.0.0.1:${address.port}/`);
}, 80000);

test("uses an explicitly requested API port", async () => {
  const explicit = makeCheckout();
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("No port");
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const output = await start(explicit, { PORT: String(address.port) });
  const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  expect(await (await fetch(`http://127.0.0.1:${address.port}/api/health`)).json()).toEqual({
    status: "ok",
  });
  expect(await (await fetch(`${url}/api/health`)).json()).toEqual({ status: "ok" });
}, 80000);

test("rejects an occupied explicitly requested web port", async () => {
  const explicit = makeCheckout();
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("No port");
  try {
    await expect(start(explicit, { WEB_PORT: String(address.port) })).rejects.toThrow(
      /: exit code 1\n/,
    );
  } finally {
    reservation.close();
  }
}, 80000);

test("uses an explicitly requested API proxy target", async () => {
  const explicit = makeCheckout();
  const target = createServer((socket) => {
    socket.end("HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\ncustom");
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const address = target.address();
  if (!address || typeof address === "string") throw new Error("No port");
  try {
    const output = await start(explicit, { API_PROXY_TARGET: `http://127.0.0.1:${address.port}` });
    const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    expect(await (await fetch(`${url}/api/test`)).text()).toBe("custom");
  } finally {
    target.close();
  }
}, 80000);

test("concurrent checkouts route to separate databases and stop independently", async () => {
  checkout ??= makeCheckout();
  const other = makeCheckout();
  const output = await start(other);
  const otherUrl = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  const firstOutput = await start(checkout);
  const firstUrl = firstOutput.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  expect(firstUrl).toBeDefined();
  expect(otherUrl).toBeDefined();
  expect(firstUrl).not.toBe(otherUrl);
  const created = await fetch(`${firstUrl}/api/meeting-types`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Only first", description: "Test", durationMinutes: 30 }),
  });
  expect(created.status).toBe(201);
  const first = await (await fetch(`${firstUrl}/api/meeting-types`)).json();
  const second = await (await fetch(`${otherUrl}/api/meeting-types`)).json();
  expect(JSON.stringify(first)).toContain("Only first");
  expect(JSON.stringify(second)).not.toContain("Only first");
  await mise(["daemons", "stop"], checkout);
  expect((await fetch(`${otherUrl}/api/health`)).status).toBe(200);
}, 80000);

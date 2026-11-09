import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runGitHubHandler } from "./opencode-handler.ts";

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((accept) => setTimeout(accept, 25));
  }
  throw new Error("Timed out waiting for handler fixture");
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function handlerFixture(pidFile: string, ignoreSignals: boolean) {
  const trap = ignoreSignals
    ? "process.on('SIGTERM', () => {}); process.on('SIGINT', () => {});"
    : "process.on('SIGTERM', () => process.exit(0)); process.on('SIGINT', () => process.exit(0));";
  return `#!${process.execPath}
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn(process.execPath, ['-e', ${JSON.stringify(`${trap} setInterval(() => {}, 1000);`)}], { stdio: 'ignore' });
writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
${trap}
console.log('Sending message to opencode...');
setInterval(() => {}, 1000);
`;
}

it("kills the whole handler process group on cancellation and reports failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-handler-kill-"));
  const baseline = process.listenerCount("SIGTERM");
  try {
    const binary = join(directory, "handler");
    const pidFile = join(directory, "grandchild.pid");
    await writeFile(binary, handlerFixture(pidFile, false), { mode: 0o700 });
    const lines: string[] = [];
    const run = runGitHubHandler({
      binary,
      workspace: directory,
      env: { PATH: process.env.PATH },
      report: (line) => lines.push(line),
      heartbeatMs: 60_000,
      killGraceMs: 1000,
    }).then(
      () => null,
      (error: Error) => error,
    );
    await waitFor(async () => {
      try {
        await readFile(pidFile, "utf8");
        return true;
      } catch {
        return false;
      }
    });
    const grandchild = Number(await readFile(pidFile, "utf8"));
    expect(alive(grandchild)).toBe(true);
    process.emit("SIGTERM");
    const error = await run;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/failed or was cancelled; fix is not confirmed/);
    await waitFor(() => !alive(grandchild));
    expect(alive(grandchild)).toBe(false);
    expect(process.listenerCount("SIGTERM")).toBe(baseline);
    expect(lines).toContain("OpenCode: handler started");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("escalates to a group SIGKILL when the handler ignores the signal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-handler-kill9-"));
  try {
    const binary = join(directory, "handler");
    const pidFile = join(directory, "grandchild.pid");
    await writeFile(binary, handlerFixture(pidFile, true), { mode: 0o700 });
    const run = runGitHubHandler({
      binary,
      workspace: directory,
      env: { PATH: process.env.PATH },
      report: () => {},
      heartbeatMs: 60_000,
      killGraceMs: 100,
    }).then(
      () => null,
      (error: Error) => error,
    );
    await waitFor(async () => {
      try {
        await readFile(pidFile, "utf8");
        return true;
      } catch {
        return false;
      }
    });
    const grandchild = Number(await readFile(pidFile, "utf8"));
    process.emit("SIGINT");
    expect(await run).toBeInstanceOf(Error);
    await waitFor(() => !alive(grandchild));
    expect(alive(grandchild)).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("reports process activity without exposing untrusted output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-handler-activity-"));
  try {
    const binary = join(directory, "handler");
    await writeFile(
      binary,
      `#!${process.execPath}
console.log('Sending message to opencode...');
console.log('private-stdout-value');
console.error('private-stderr-value');
setTimeout(() => process.exit(0), 160);
`,
      { mode: 0o700 },
    );
    const lines: string[] = [];
    await runGitHubHandler({
      binary,
      workspace: directory,
      env: { PATH: process.env.PATH },
      report: (line) => lines.push(line),
      heartbeatMs: 40,
    });
    expect(lines).toContain("OpenCode: handler started");
    expect(lines).toContain("OpenCode: processing request");
    expect(lines).toContain("OpenCode: processing request; stdout active; stderr active");
    expect(lines).toContain("OpenCode: processing request; stdout quiet; stderr quiet");
    expect(lines).toContain("OpenCode: upstream handler completed");
    expect(lines.join(" ")).not.toContain("private-");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("does not forward a dynamically exchanged App credential when Git configuration fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-handler-log-"));
  const token = "dynamic-app-token-not-known-to-parent";
  const encoded = Buffer.from(`x-access-token:${token}`).toString("base64");
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ token }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    execFileSync("git", ["init", "--quiet", directory]);
    await writeFile(join(directory, ".git/config.lock"), "force genuine git-config failure");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture server missing");
    const binary = join(directory, "handler");
    const receipt = join(directory, "failed");
    await writeFile(
      binary,
      `#!${process.execPath}
import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const token = (await (await fetch('http://127.0.0.1:${address.port}/exchange')).json()).token;
const encoded = Buffer.from('x-access-token:' + token).toString('base64');
const result = spawnSync('git', ['config', '--local', 'http.https://github.com/.extraheader', 'AUTHORIZATION: basic ' + encoded]);
writeFileSync(${JSON.stringify(receipt)}, String(result.status));
console.log('Configuring git...');
console.error('Process.RunFailedError: git config AUTHORIZATION: basic ' + encoded);
console.log(token);
console.log('::error::' + encoded);
process.exit(result.status);
`,
      { mode: 0o700 },
    );
    const lines: string[] = [];
    await expect(
      runGitHubHandler({
        binary,
        workspace: directory,
        env: { PATH: process.env.PATH },
        report: (line) => lines.push(line),
      }),
    ).rejects.toThrow(/not confirmed/);
    expect(Number(await readFile(receipt, "utf8"))).not.toBe(0);
    expect(lines).toContain("OpenCode: configuring Git");
    expect(lines.join("\n")).not.toContain(token);
    expect(lines.join("\n")).not.toContain(encoded);
    expect(lines.join("\n")).not.toContain("::error::");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

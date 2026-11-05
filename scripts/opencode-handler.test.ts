import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runGitHubHandler } from "./opencode-handler.ts";

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

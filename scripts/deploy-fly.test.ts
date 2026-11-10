import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";

const repo = fileURLToPath(new URL("../", import.meta.url));
const scenarioTimeoutMs = 30_000;
const scenarioTestTimeoutMs = scenarioTimeoutMs + 5_000;
const revision = "a".repeat(40);
const localImageId = `sha256:${"b".repeat(64)}`;
const digest = `sha256:${"c".repeat(64)}`;
const machineConfig = {
  metadata: { fly_release_id: "release-1", fly_release_version: "1" },
  services: [
    {
      internal_port: 3000,
      autostop: "stop",
      autostart: true,
      checks: [{ type: "http", path: "/api/health" }],
    },
  ],
};

const fakeGit = `#!${process.execPath}
const fs = require('fs');
const path = require('path');
const dir = process.env.FIXTURE;
const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'git.log'), JSON.stringify(args) + '\\n');
const command = args[0];
const calls = fs.readFileSync(path.join(dir, 'git.log'), 'utf8').trim().split('\\n').map(JSON.parse);
if (config.fail === command) process.exit(7);
if (command === 'branch') console.log(config.branch || 'main');
else if (command === 'status') console.log(config.dirty || '');
else if (command === 'merge' && config.mergeApp) fs.writeFileSync(path.join(dir, 'fly.toml'), "app = '" + config.mergeApp + "'\\n");
else if (command === 'rev-parse' && args[1] === '--show-toplevel') console.log(dir);
else if (command === 'rev-parse') {
  const sequence = config.refSequence;
  const index = calls.filter(c => c[0] === 'rev-parse' && c[1] === 'HEAD').length - 1;
  const refs = sequence?.[Math.min(index, sequence.length - 1)] || [config.revision, config.revision, config.revision];
  console.log(refs.join('\\n'));
}
else if (command === 'ls-tree') process.stdout.write(config.entries.map(e => (e.mode || '100644') + ' blob ' + e.object + '\\t' + e.path + '\\0').join(''));
else if (command === 'cat-file') process.stdout.write('content:' + config.entries.find(e => e.object === args[2]).path);
`;

const fakeDocker = `#!${process.execPath}
const fs = require('fs');
const path = require('path');
const dir = process.env.FIXTURE;
const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'docker.log'), JSON.stringify(args) + '\\n');
const image = config.localImageId;
if (args[0] === 'build') {
  fs.readFileSync(0);
  fs.writeFileSync(args[args.indexOf('--iidfile') + 1], image);
}
else if (args[0] === 'image' && args[1] === 'inspect') {
  const target = args[2];
  if (target.startsWith('registry.fly.io/')) {
    if (config.digestMismatch) console.log(JSON.stringify(['registry.fly.io/other@' + '${"d".repeat(64)}']));
    else console.log(JSON.stringify([target.split(':')[0] + '@${digest}']));
  } else {
    console.log(JSON.stringify([{ Id: image, Os: 'linux', Architecture: 'amd64', Config: { Labels: { 'org.opencontainers.image.revision': config.revision } } }]));
  }
}
else if (args[0] === 'create') {
  config.verifyLabel = args[args.indexOf('--label') + 1].split('=')[1];
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  console.log('container-id');
}
else if (args[0] === 'start') {}
else if (args[0] === 'port') { console.log('127.0.0.1:' + process.env.FAKE_PORT); }
else if (args[0] === 'container' && args[1] === 'inspect') {
  console.log(JSON.stringify({ Id: 'f'.repeat(64), Config: { Labels: { 'calendar.deploy.verify': config.verifyLabel } } }));
}
else if (args[0] === 'rm') { fs.appendFileSync(path.join(dir, 'docker.log'), '"removed"\\n'); }
else if (args[0] === 'tag') {}
else if (args[0] === 'manifest') {
  if (config.manifestExists) console.log('{"schemaVersion":2}');
  else process.exit(1);
}
else if (args[0] === 'push') {
  if (config.pushFails) process.exit(9);
}
else process.exit(1);
`;

const fakeFly = `#!${process.execPath}
const fs = require('fs');
const path = require('path');
const dir = process.env.FIXTURE;
const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'fly.log'), JSON.stringify(args) + '\\n');
const statePath = path.join(dir, 'fly-state.json');
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};
if (args[0] === 'auth') process.exit(0);
if (args[0] === 'machines') {
  if (config.machinesBusy) { console.log(JSON.stringify([{ id: 'm1', state: 'updating', image_ref: { digest: 'sha256:' + '0'.repeat(64) }, checks: [] }])); process.exit(0); }
  console.log(JSON.stringify(state.deployed && config.postDeployMachines !== undefined ? config.postDeployMachines : [{ id: 'm1', state: 'started', image_ref: { digest: state.deployed || '${digest}' }, config: ${JSON.stringify(machineConfig)}, checks: [{ name: 'servicecheck-00-http-3000', status: 'passing' }] }]));
  process.exit(0);
}
if (args[0] === 'releases') {
  if (config.releaseReadFails) process.exit(7);
  const app = args[args.indexOf('--app') + 1];
  console.log(JSON.stringify(config.releases ?? [{ ID: 'release-1', Version: 1, Status: 'complete', InProgress: false, ImageRef: 'registry.fly.io/' + app + '@${digest}' }]));
  process.exit(0);
}
if (args[0] === 'deploy') {
  // Test-only latency injection: no Fly API or real deployment is involved.
  const delay = Math.min(10000, Math.max(0, Number(config.deployDelayMs) || 0));
  if (delay) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
  if (config.deployFails) { process.stderr.write('Error: EOF'); process.exit(1); }
  state.deployed = args[args.indexOf('--image') + 1].split('@')[1];
  fs.writeFileSync(statePath, JSON.stringify(state));
  process.exit(0);
}
process.exit(1);
`;

function fixture(configOverrides: Record<string, unknown> = {}, bundleJs?: string) {
  const dir = mkdtempSync(join(tmpdir(), "deploy-fly-test-"));
  mkdirSync(join(dir, "scripts"));
  for (const file of ["deploy-fly.mjs", "deploy-prepare.mjs"])
    cpSync(join(repo, "scripts", file), join(dir, "scripts", file));
  writeFileSync(join(dir, "version.txt"), "0.0.0\n");
  writeFileSync(join(dir, "fly.toml"), "app = 'calendar-test-app'\n");
  symlinkSync(join(repo, "node_modules"), join(dir, "node_modules"));
  const entries = [
    "Dockerfile",
    ".dockerignore",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "version.txt",
    "apps/api/package.json",
    "apps/web/package.json",
  ].map((path, index) => ({ path, object: (index + 1).toString(16).padStart(40, "0") }));
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({
      revision,
      localImageId,
      entries,
      deployDelayMs: Number(process.env.CALENDAR_DEPLOY_FIXTURE_DELAY_MS ?? 0),
      ...configOverrides,
    }),
  );
  writeFileSync(join(dir, "git"), fakeGit, { mode: 0o755 });
  writeFileSync(join(dir, "docker"), fakeDocker, { mode: 0o755 });
  writeFileSync(join(dir, "fly"), fakeFly, { mode: 0o755 });
  const bundle =
    bundleJs ?? `console.info(${JSON.stringify(`Calendar v0.0.0 (${revision.slice(0, 7)})`)});`;
  const server: Server = createServer((request, response) => {
    if (request.url === "/api/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"status":"ok"}');
    } else if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end('<html><body><script src="/assets/index.js"></script></body></html>');
    } else if (request.url === "/assets/index.js") {
      response.writeHead(200, { "content-type": "application/javascript" });
      response.end(bundle);
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    TMPDIR: dir,
    FIXTURE: dir,
  };
  const start = () =>
    new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
    });
  // Async spawn: the fixture HTTP server lives in this process, so a blocking
  // spawnSync call would deadlock the child's health and page requests.
  const run = (port?: number, timeout = 120_000) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [join(dir, "scripts", "deploy-fly.mjs")], {
        cwd: dir,
        env: {
          ...env,
          FAKE_PORT: String(port),
          ...(port ? { CALENDAR_DEPLOY_URL: `http://127.0.0.1:${port}` } : {}),
        },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });
      child.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(
          new Error(
            `deploy-fly.mjs exceeded the ${timeout} ms test deadline\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          ),
        );
      }, timeout);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (status) => {
        clearTimeout(timer);
        resolve({ status, stdout, stderr });
      });
    });
  const log = (name: string) =>
    (existsSync(join(dir, `${name}.log`)) ? readFileSync(join(dir, `${name}.log`), "utf8") : "")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
  const cleanup = () => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, start, run, log, cleanup };
}

it("refuses to run while another local deployment holds the lock", async () => {
  const f = fixture();
  try {
    const port = await f.start();
    const lock = join(
      f.dir,
      `calendar-deploy-${createHash("sha256").update(realpathSync(f.dir)).digest("hex").slice(0, 16)}.lock`,
    );
    writeFileSync(lock, "999999\n");
    const result = await f.run(port);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("another deployment is running");
    expect(readFileSync(lock, "utf8")).toBe("999999\n");
    const next = await f.run(port);
    expect(next.status).not.toBe(0);
    expect(next.stderr).toContain("another deployment is running");
    expect(readFileSync(lock, "utf8")).toBe("999999\n");
    expect(f.log("git")).toEqual([]);
  } finally {
    f.cleanup();
  }
});

it.each([
  [{ branch: "feature/x" }, "must already be on main"],
  [{ dirty: "?? untracked" }, "dirty or has untracked"],
])("refuses a %s checkout before fetching or merging", async (config, message) => {
  const f = fixture(config);
  try {
    const port = await f.start();
    const result = await f.run(port);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
    const calls = f.log("git");
    expect(calls.some((args) => args[0] === "fetch" || args[0] === "merge")).toBe(false);
    expect(f.log("docker").some((args) => args[0] === "push")).toBe(false);
  } finally {
    f.cleanup();
  }
});

it(
  "reports an unresolved push after inspecting the registry manifest",
  { timeout: scenarioTestTimeoutMs },
  async () => {
    const f = fixture({ pushFails: true, manifestExists: true });
    try {
      const port = await f.start();
      const result = await f.run(port, scenarioTimeoutMs);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("registry push outcome is unresolved");
      expect(result.stderr).toContain("manifest exists");
      expect(result.stderr).toContain("Do NOT retry blindly");
      expect(f.log("fly").some((args) => args[0] === "deploy")).toBe(false);
    } finally {
      f.cleanup();
    }
  },
);

it(
  "publishes and rolls out to the app selected by the fast-forwarded configuration",
  { timeout: scenarioTestTimeoutMs },
  async () => {
    const f = fixture({ mergeApp: "calendar-updated-app" });
    try {
      const port = await f.start();
      const result = await f.run(port, scenarioTimeoutMs);
      expect(result.status, result.stderr).toBe(0);
      expect(f.log("docker").find((args) => args[0] === "push")?.[1]).toMatch(
        /^registry\.fly\.io\/calendar-updated-app:/,
      );
      const deploy = f.log("fly").find((args) => args[0] === "deploy");
      expect(deploy?.[deploy.indexOf("--app") + 1]).toBe("calendar-updated-app");
      expect(deploy).toContain(`registry.fly.io/calendar-updated-app@${digest}`);
    } finally {
      f.cleanup();
    }
  },
);

it("stops without pushing when the source revision advanced after preparation", async () => {
  const f = fixture({
    refSequence: [
      [revision, revision, revision],
      [revision, revision, revision],
      [revision, revision, revision],
      [revision, revision, revision],
      ["b".repeat(40), "b".repeat(40), "b".repeat(40)],
    ],
  });
  try {
    const port = await f.start();
    const result = await f.run(port);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("source revision advanced");
    expect(f.log("docker").some((args) => args[0] === "push")).toBe(false);
    expect(f.log("fly").some((args) => args[0] === "deploy")).toBe(false);
  } finally {
    f.cleanup();
  }
});

it("stops without publishing if preparation advances the configuration revision", async () => {
  const advanced = "d".repeat(40);
  const f = fixture(
    {
      revision: advanced,
      refSequence: [
        [revision, revision, revision],
        [advanced, advanced, advanced],
      ],
    },
    "console.info('Calendar v0.0.0 (ddddddd)');",
  );
  try {
    const port = await f.start();
    const result = await f.run(port);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("configuration revision changed during preparation");
    expect(f.log("docker").some((args) => args[0] === "push")).toBe(false);
    expect(f.log("fly").some((args) => args[0] === "deploy")).toBe(false);
  } finally {
    f.cleanup();
  }
});

it("stops before publishing while machines are in transition", async () => {
  const f = fixture({ machinesBusy: true });
  try {
    const port = await f.start();
    const result = await f.run(port);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("another rollout may be in progress");
    expect(f.log("docker").some((args) => args[0] === "push")).toBe(false);
  } finally {
    f.cleanup();
  }
});

it("fails closed when the registry digest does not match the pushed tag", async () => {
  const f = fixture({ digestMismatch: true });
  try {
    const port = await f.start();
    const result = await f.run(port);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("valid registry digest");
    expect(f.log("fly").some((args) => args[0] === "deploy")).toBe(false);
  } finally {
    f.cleanup();
  }
});

it("reports an unresolved rollout instead of retrying", async () => {
  const f = fixture({ deployFails: true });
  try {
    const port = await f.start();
    const result = await f.run(port);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("rollout outcome is unknown");
    expect(result.stderr).toContain("do NOT retry blindly");
  } finally {
    f.cleanup();
  }
});

it(
  "fails verification when the deployed frontend reports another revision",
  { timeout: scenarioTestTimeoutMs },
  async () => {
    // The bundle carries the expected marker as a comment (pre-push smoke passes)
    // but the browser console reports a different revision.
    const f = fixture(
      {},
      `/* Calendar v0.0.0 (${revision.slice(0, 7)}) */ console.info('Calendar v0.0.0 (fffffff)');`,
    );
    try {
      const port = await f.start();
      const result = await f.run(port, scenarioTimeoutMs);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("deployed frontend reports");
    } finally {
      f.cleanup();
    }
  },
);

it.each([
  { label: "missing", checks: undefined },
  { label: "empty", checks: [] },
  { label: "failing", checks: [{ name: "health", status: "critical" }] },
])(
  "does not verify a started machine with unconfirmed health checks ($label)",
  async ({ checks }) => {
    const f = fixture({
      postDeployMachines: [{ id: "m1", state: "started", image_ref: { digest }, checks }],
    });
    try {
      const port = await f.start();
      const result = await f.run(port);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("unconfirmed health checks");
      expect(result.stderr).not.toContain("Deployment verified:");
    } finally {
      f.cleanup();
    }
  },
);

it.each(["starting", "failed", "created", "stopped"])(
  "does not verify an unconfirmed %s machine even when another machine is healthy",
  async (state) => {
    const f = fixture({
      postDeployMachines: [
        {
          id: "healthy",
          state: "started",
          image_ref: { digest },
          checks: [{ name: "health", status: "passing" }],
        },
        { id: "unconfirmed", state, image_ref: { digest } },
      ],
    });
    try {
      const port = await f.start();
      const result = await f.run(port);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("unconfirmed machine state");
      expect(result.stderr).not.toContain("Deployment verified:");
    } finally {
      f.cleanup();
    }
  },
);

it("does not verify an empty deployment machine listing", async () => {
  const f = fixture({ postDeployMachines: [] });
  try {
    const port = await f.start();
    const result = await f.run(port);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("empty or invalid machine listing");
    expect(result.stderr).not.toContain("Deployment verified:");
  } finally {
    f.cleanup();
  }
});

it.each([
  { label: "absent", releases: [] },
  {
    label: "missing image",
    releases: [{ ID: "release-1", Version: 1, Status: "complete", InProgress: false }],
  },
  {
    label: "wrong digest",
    releases: [
      {
        ID: "release-1",
        Version: 1,
        Status: "complete",
        InProgress: false,
        ImageRef: `registry.fly.io/calendar-test-app@sha256:${"d".repeat(64)}`,
      },
    ],
  },
  {
    label: "wrong app",
    releases: [
      {
        ID: "release-1",
        Version: 1,
        Status: "complete",
        InProgress: false,
        ImageRef: `registry.fly.io/other@${digest}`,
      },
    ],
  },
  {
    label: "failed",
    releases: [
      {
        ID: "release-1",
        Version: 1,
        Status: "failed",
        InProgress: false,
        ImageRef: `registry.fly.io/calendar-test-app@${digest}`,
      },
    ],
  },
  {
    label: "pending",
    releases: [
      {
        ID: "release-1",
        Version: 1,
        Status: "complete",
        InProgress: true,
        ImageRef: `registry.fly.io/calendar-test-app@${digest}`,
      },
    ],
  },
  {
    label: "superseded",
    releases: [
      {
        ID: "release-1",
        Version: 1,
        Status: "complete",
        InProgress: false,
        ImageRef: `registry.fly.io/calendar-test-app@${digest}`,
      },
      {
        ID: "release-2",
        Version: 2,
        Status: "failed",
        InProgress: false,
        ImageRef: `registry.fly.io/calendar-test-app@${digest}`,
      },
    ],
  },
  { label: "unreadable", releaseReadFails: true },
])("does not verify an unconfirmed release ($label)", async (config) => {
  const f = fixture(config);
  try {
    const port = await f.start();
    const result = await f.run(port);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("release");
    expect(result.stderr).not.toContain("Deployment verified:");
  } finally {
    f.cleanup();
  }
});

it.each([undefined, { fly_release_id: "older-release", fly_release_version: "1" }])(
  "does not verify a machine without the confirmed release identity (%j)",
  async (metadata) => {
    const f = fixture({
      postDeployMachines: [
        {
          id: "m1",
          state: "started",
          image_ref: { digest },
          config: { ...machineConfig, metadata },
          checks: [{ name: "servicecheck-00-http-3000", status: "passing" }],
        },
      ],
    });
    try {
      const port = await f.start();
      const result = await f.run(port);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("machines do not match the confirmed release");
      expect(result.stderr).not.toContain("Deployment verified:");
    } finally {
      f.cleanup();
    }
  },
);

it("does not substitute an unrelated passing check for the configured HTTP health check", async () => {
  const f = fixture({
    postDeployMachines: [
      {
        id: "m1",
        state: "started",
        image_ref: { digest },
        config: machineConfig,
        checks: [{ name: "tcp-alive", status: "passing" }],
      },
    ],
  });
  try {
    const port = await f.start();
    const result = await f.run(port);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unconfirmed health checks");
    expect(result.stderr).not.toContain("Deployment verified:");
  } finally {
    f.cleanup();
  }
});

it.each([
  { reason: "missing events", events: undefined },
  {
    reason: "OOM after exhausted restarts",
    events: [
      {
        type: "exit",
        status: "stopped",
        source: "flyd",
        timestamp: 1793725200000,
        request: {
          exit_event: {
            exit_code: 137,
            oom_killed: true,
            requested_stop: false,
            restarting: false,
          },
          restart_count: 10,
        },
      },
    ],
  },
  {
    reason: "application exit",
    events: [
      {
        type: "exit",
        status: "stopped",
        source: "flyd",
        timestamp: 1793725200000,
        request: { exit_event: { exit_code: 0, requested_stop: false } },
      },
    ],
  },
  {
    reason: "requested stop with an unknown origin",
    events: [
      {
        type: "exit",
        status: "stopped",
        source: "flyd",
        timestamp: 1793725200000,
        request: { exit_event: { exit_code: 0, requested_stop: true } },
      },
    ],
  },
])("does not infer a confirmed autostop from policy alone ($reason)", async ({ events }) => {
  const f = fixture({
    postDeployMachines: [
      {
        id: "started",
        state: "started",
        image_ref: { digest },
        config: machineConfig,
        checks: [{ name: "servicecheck-00-http-3000", status: "passing" }],
      },
      { id: "stopped", state: "stopped", image_ref: { digest }, config: machineConfig, events },
    ],
  });
  try {
    const port = await f.start();
    const result = await f.run(port);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unconfirmed machine state: stopped:stopped");
    expect(result.stderr).not.toContain("Deployment verified:");
  } finally {
    f.cleanup();
  }
});

it(
  "publishes the verified image by digest and confirms the public frontend version",
  { timeout: scenarioTestTimeoutMs },
  async () => {
    const f = fixture();
    try {
      const port = await f.start();
      const result = await f.run(port, scenarioTimeoutMs);
      expect(result.status, result.stderr).toBe(0);
      const docker = f.log("docker");
      const push = docker.find((args) => args[0] === "push");
      expect(push?.[1]).toMatch(/^registry\.fly\.io\/calendar-test-app:deploy-a{7}-\d+$/);
      const fly = f.log("fly");
      const deploy = fly.find((args) => args[0] === "deploy");
      expect(deploy).toContain(`registry.fly.io/calendar-test-app@${digest}`);
      expect(deploy).toContain("--strategy");
      const provenanceDirs = readdirSync(f.dir).filter((name) =>
        name.startsWith("calendar-deploy-provenance-"),
      );
      expect(provenanceDirs).toHaveLength(1);
      const provenance = JSON.parse(
        readFileSync(join(f.dir, provenanceDirs[0], "provenance.json"), "utf8"),
      );
      expect(provenance).toMatchObject({
        sourceRevision: revision,
        localImageId,
        registryDigest: digest,
        releaseId: "release-1",
        releaseVersion: 1,
      });
      expect(readdirSync(f.dir).some((name) => name.endsWith(".lock"))).toBe(false);
      expect(result.stdout).toContain("Deployed registry.fly.io/");
      expect(result.stderr).toContain(`Deployment verified: http://127.0.0.1:${port}`);
    } finally {
      f.cleanup();
    }
  },
);

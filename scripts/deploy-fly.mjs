import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { accessSync, constants, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

// Explicitly invoked deployment: prepare → verify → publish → rollout → verify.
// A local lock prevents concurrent runs on this machine only; it cannot exclude
// a deployment started from another host or tool. Run deployments sequentially.

const root = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
const runId = randomBytes(8).toString("hex");
const sha = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const imageId = /^sha256:[a-f0-9]{64}$/;
const repoDigest = /^registry\.fly\.io\/[a-z0-9-]+@sha256:[a-f0-9]{64}$/;
// Do not inherit Git's repository/config overrides from a caller's shell.
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  GIT_NO_REPLACE_OBJECTS: "1",
};
const run = (program, args, options = {}) =>
  execFileSync(program, args, { env, cwd: root, timeout: 60_000, ...options });
const git = (...args) =>
  run("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const lockPath = join(
  tmpdir(),
  `calendar-deploy-${createHash("sha256").update(root).digest("hex").slice(0, 16)}.lock`,
);
const lockOwner = `${process.pid}:${runId}\n`;
let lockAcquired = false;
function acquireLock() {
  try {
    writeFileSync(lockPath, lockOwner, { flag: "wx" });
    lockAcquired = true;
  } catch {
    throw new Error(
      `another deployment is running or a stale lock exists: ${lockPath}. This lock is local to this machine; verify the other run finished before removing it.`,
    );
  }
}
function releaseLock() {
  if (lockAcquired && readFileSync(lockPath, "utf8") === lockOwner) rmSync(lockPath);
}

function findFly() {
  try {
    const found = run("sh", ["-c", "command -v fly"], { encoding: "utf8" }).trim();
    if (found) return found;
  } catch {
    // fall through to the documented installer location
  }
  for (const candidate of ["flyctl", "fly"]) {
    const fallback = join(homedir(), ".fly", "bin", candidate);
    try {
      accessSync(fallback, constants.X_OK);
      return fallback;
    } catch {
      // try the next documented installer location
    }
  }
  throw new Error("Fly CLI not found on PATH or under ~/.fly/bin/");
}

function appName() {
  const match = /^app = '([a-z0-9-]+)'$/m.exec(readFileSync(join(root, "fly.toml"), "utf8"));
  if (!match) throw new Error("fly.toml does not declare an app name");
  return match[1];
}

function checkoutState() {
  if (git("branch", "--show-current") !== "main")
    throw new Error("checkout must already be on main");
  if (git("status", "--porcelain=v1", "--untracked-files=all"))
    throw new Error("checkout is dirty or has untracked files");
}

// Check the caller's branch first: fetching or fast-forwarding must never move
// a feature branch, so branch/dirty checks run before any ref update and again
// afterwards, before trusting the revision.
function gate(expectedRevision) {
  checkoutState();
  git(
    "fetch",
    "--no-tags",
    "--no-prune",
    "--no-recurse-submodules",
    "--no-write-fetch-head",
    "--refmap=",
    "origin",
    "refs/heads/main:refs/remotes/origin/main",
  );
  git("merge", "--ff-only", "--no-overwrite-ignore", "origin/main");
  checkoutState();
  const refs = git("rev-parse", "HEAD", "refs/heads/main", "refs/remotes/origin/main").split("\n");
  if (refs.length !== 3 || !refs.every((ref) => sha.test(ref) && ref === refs[0]))
    throw new Error("HEAD, local main and origin/main must be identical full revisions");
  if (expectedRevision && refs[0] !== expectedRevision)
    throw new Error(
      `source revision advanced from ${expectedRevision} to ${refs[0]}; prepare a new artifact`,
    );
  return refs[0];
}

function prepare() {
  const result = spawnSync(process.execPath, [join(root, "scripts", "deploy-prepare.mjs")], {
    env,
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    timeout: 30 * 60_000,
  });
  if (result.status !== 0) throw new Error("preparation failed");
  const path = /provenance: (.+)\n/.exec(result.stdout)?.[1];
  if (!path) throw new Error("preparation did not report a provenance record");
  const record = JSON.parse(readFileSync(path, "utf8"));
  if (
    record.schemaVersion !== 1 ||
    !sha.test(record.sourceRevision) ||
    !imageId.test(record.localImageId) ||
    record.platform !== "linux/amd64"
  )
    throw new Error("invalid provenance record");
  return { path, record };
}

async function smokeImage(record) {
  const name = `calendar-deploy-verify-${runId}`;
  const label = `calendar.deploy.verify=${runId}`;
  const dockerRun = (args, options = {}) => run("docker", args, options);
  let created = false;
  try {
    const inspected = JSON.parse(
      dockerRun(["image", "inspect", record.localImageId], { encoding: "utf8" }),
    );
    const image = Array.isArray(inspected) && inspected.length === 1 ? inspected[0] : null;
    if (image?.Config?.Labels?.["org.opencontainers.image.revision"] !== record.sourceRevision)
      throw new Error("local image no longer matches the prepared revision");
    dockerRun(
      [
        "create",
        "--platform",
        "linux/amd64",
        "--name",
        name,
        "--label",
        label,
        "-p",
        "127.0.0.1::8181",
        "-e",
        "PORT=8181",
        "-e",
        "DATABASE_PATH=:memory:",
        record.localImageId,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    created = true;
    dockerRun(["start", name], { stdio: ["ignore", "pipe", "pipe"] });
    const mapping = dockerRun(["port", name, "8181/tcp"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const port = /127\.0\.0\.1:(\d+)$/.exec(mapping)?.[1];
    if (!port) throw new Error(`unexpected port mapping: ${mapping}`);
    const version = readFileSync(join(root, "version.txt"), "utf8").trim();
    const expected = `Calendar v${version} (${record.sourceRevision.slice(0, 7)})`;
    const deadline = Date.now() + 90_000;
    let page;
    while (Date.now() < deadline) {
      try {
        const health = await fetch(`http://127.0.0.1:${port}/api/health`, {
          signal: AbortSignal.timeout(2_000),
        });
        if (health.status === 200 && JSON.stringify(await health.json()) === '{"status":"ok"}') {
          const index = await fetch(`http://127.0.0.1:${port}/`);
          const html = await index.text();
          const asset = /src="([^"]+\.js)"/.exec(html)?.[1];
          if (index.status === 200 && asset) {
            const script = await fetch(`http://127.0.0.1:${port}${asset}`);
            if (script.status === 200 && (await script.text()).includes(expected)) {
              page = expected;
              break;
            }
          }
        }
      } catch {
        // container is still starting
      }
      await delay(500);
    }
    if (!page) throw new Error(`prepared image did not serve ${expected} within 90 seconds`);
    console.error(`Prepared image verified locally: ${page}`);
  } finally {
    if (created) {
      try {
        const details = JSON.parse(
          dockerRun(["container", "inspect", "--format", "{{json .}}", name], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          }),
        );
        if (details?.Config?.Labels?.["calendar.deploy.verify"] !== runId)
          throw new Error("verification container ownership mismatch; left untouched");
        dockerRun(["rm", "-f", details.Id], { stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        throw new Error(`could not clean verification container ${name}: ${error.message}`, {
          cause: error,
        });
      }
    }
  }
}

function publish(fly, app, record) {
  run(fly, ["auth", "docker"], { stdio: "inherit", timeout: 60_000 });
  const tag = `registry.fly.io/${app}:deploy-${record.sourceRevision.slice(0, 7)}-${Date.now()}`;
  run("docker", ["tag", record.localImageId, tag], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    run("docker", ["push", tag], { stdio: "inherit", timeout: 30 * 60_000 });
  } catch (error) {
    // The push may have completed on the registry even though the client failed.
    let observed = "registry state could not be read";
    try {
      const manifest = run("docker", ["manifest", "inspect", "--verbose", tag], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60_000,
      });
      observed = `manifest exists: ${manifest.trim().slice(0, 500)}`;
    } catch {
      observed = `no manifest readable for ${tag}`;
    }
    throw new Error(
      `registry push outcome is unresolved (${observed}). Do NOT retry blindly: first confirm whether ${tag} was published and whether any rollout started. Client error: ${error.message}`,
    );
  }
  const digests = JSON.parse(
    run("docker", ["image", "inspect", tag, "--format", "{{json .RepoDigests}}"], {
      encoding: "utf8",
    }),
  );
  if (!Array.isArray(digests) || digests.length !== 1 || !repoDigest.test(digests[0]))
    throw new Error(`push did not produce exactly one valid registry digest: ${digests}`);
  return digests[0];
}

function machines(fly, app) {
  return JSON.parse(run(fly, ["machines", "list", "--app", app, "--json"], { encoding: "utf8" }));
}

function ensureSettled(list) {
  const busy = ["updating", "destroying", "replacing", "cloning", "stopping", "starting"];
  if (!Array.isArray(list)) throw new Error("unexpected machine listing");
  const active = list.filter((machine) => busy.includes(machine.state));
  if (active.length)
    throw new Error(
      `machines are in transition (${active.map((m) => `${m.id}:${m.state}`).join(", ")}); another rollout may be in progress. Wait and re-check before deploying.`,
    );
}

function rollout(fly, app, image) {
  try {
    run(
      fly,
      [
        "deploy",
        "--app",
        app,
        "--image",
        image,
        "--strategy",
        "rolling",
        "--ha=false",
        "--deploy-retries",
        "0",
        "--wait-timeout",
        "10m",
        "--yes",
      ],
      { stdio: "inherit", timeout: 25 * 60_000 },
    );
  } catch (error) {
    let state = "unavailable";
    try {
      state = JSON.stringify(machines(fly, app));
    } catch {
      // inspection failed too
    }
    throw new Error(
      `rollout outcome is unknown; do NOT retry blindly. Machine state: ${state}. Error: ${error.message}`,
    );
  }
}

// CALENDAR_DEPLOY_URL exists for automated tests; it may only point at a local
// loopback fixture so a stray environment value cannot fake a public result.
function verificationUrl(app) {
  const override = process.env.CALENDAR_DEPLOY_URL;
  if (!override) return `https://${app}.fly.dev`;
  const host = new URL(override).hostname;
  if (!["127.0.0.1", "localhost", "[::1]"].includes(host))
    throw new Error(`CALENDAR_DEPLOY_URL may only target loopback, got ${override}`);
  return override;
}

function healthChecksConfirmed(machine) {
  const checks = machine.checks;
  if (
    !Array.isArray(checks) ||
    !checks.length ||
    checks.some(
      (check) => typeof check?.name !== "string" || !check.name || check.status !== "passing",
    )
  )
    return false;
  const services = machine.config?.services;
  if (!Array.isArray(services)) return false;
  const healthServices = services.filter(
    (service) =>
      Array.isArray(service?.checks) &&
      service.checks.some((check) => check?.type === "http" && check.path === "/api/health"),
  );
  // Fly names service HTTP checks servicecheck-<index>-http-<port>. Require
  // the configured health service, not just any unrelated passing check.
  return (
    healthServices.length > 0 &&
    healthServices.every((service) => {
      if (!Number.isSafeInteger(service.internal_port) || service.internal_port <= 0) return false;
      const name = new RegExp(`^servicecheck-\\d+-http-${service.internal_port}$`);
      const reported = new Set(
        checks.filter((check) => name.test(check.name)).map((check) => check.name),
      );
      return reported.size >= service.checks.filter((check) => check?.type === "http").length;
    })
  );
}

async function verify(fly, app, image, sourceRevision) {
  const url = verificationUrl(app);
  const deadline = Date.now() + 150_000;
  let healthy = false;
  while (Date.now() < deadline && !healthy) {
    try {
      const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(10_000) });
      healthy =
        response.status === 200 && JSON.stringify(await response.json()) === '{"status":"ok"}';
    } catch {
      // autostop machines need a request to start
    }
    if (!healthy) await delay(2_000);
  }
  if (!healthy) throw new Error(`public health check did not pass at ${url}`);
  const list = machines(fly, app);
  if (!Array.isArray(list) || !list.length || list.some((machine) => !machine?.id))
    throw new Error("empty or invalid machine listing; deployment remains unverified");
  // The public Machine schema does not provide an unambiguous autostop reason.
  // Enabled autostop or requested_stop=true cannot distinguish an idle shutdown
  // from a crash, manual stop or another platform action. Fail closed rather
  // than inventing event-source values or starting/restarting Machines here.
  const unsettled = list.filter((machine) => machine.state !== "started");
  if (unsettled.length)
    throw new Error(
      `unconfirmed machine state: ${unsettled.map((m) => `${m.id}:${m.state}`).join(", ")}. ` +
        "Stopped Machines cannot be confirmed as autostop from policy alone; inspect their state before any further deployment. No automatic start or restart was attempted.",
    );
  const mismatched = list.filter((machine) => machine.image_ref?.digest !== image.split("@")[1]);
  if (mismatched.length)
    throw new Error(
      `machines run an unexpected image: ${mismatched.map((m) => `${m.id}:${m.image_ref?.digest}`).join(", ")}`,
    );
  const failing = list.filter(
    (machine) => machine.state === "started" && !healthChecksConfirmed(machine),
  );
  if (failing.length)
    throw new Error(
      `started machines have unconfirmed health checks: ${failing.map((m) => m.id).join(", ")}`,
    );
  // fly releases --json emits fly-go Release fields (ID, Version, Status,
  // InProgress, ImageRef). Never accept a matching historical release while a
  // newer release is failed, pending or points to another image.
  const releases = JSON.parse(run(fly, ["releases", "--app", app, "--json"], { encoding: "utf8" }));
  if (
    !Array.isArray(releases) ||
    !releases.length ||
    releases.some((release) => !Number.isSafeInteger(release?.Version) || release.Version <= 0)
  )
    throw new Error("empty or invalid release listing; deployment remains unverified");
  const latest = [...releases].sort((a, b) => b.Version - a.Version)[0];
  if (
    typeof latest.ID !== "string" ||
    !latest.ID ||
    latest.Status !== "complete" ||
    latest.InProgress !== false ||
    latest.ImageRef !== image
  )
    throw new Error("latest release does not confirm the published image and completed rollout");
  if (
    list.some(
      (machine) =>
        machine.config?.metadata?.fly_release_id !== latest.ID ||
        machine.config?.metadata?.fly_release_version !== String(latest.Version),
    )
  )
    throw new Error("machines do not match the confirmed release");
  const version = readFileSync(join(root, "version.txt"), "utf8").trim();
  const expected = `Calendar v${version} (${sourceRevision.slice(0, 7)})`;
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errors = [];
    const messages = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
      if (message.type() === "info" && message.text().startsWith("Calendar v"))
        messages.push(message.text());
    });
    await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
    if (JSON.stringify(messages) !== JSON.stringify([expected]))
      throw new Error(
        `deployed frontend reports ${JSON.stringify(messages)}, expected ${expected}`,
      );
    if (errors.length) throw new Error(`browser errors: ${errors.join("; ")}`);
  } finally {
    await browser.close();
  }
  console.error(`Deployment verified: ${url} serves ${expected}`);
  return { releaseId: latest.ID, releaseVersion: latest.Version };
}

async function main() {
  acquireLock();
  const fly = findFly();
  const configurationRevision = gate();
  const app = appName();
  const { path, record } = prepare();
  if (record.sourceRevision !== configurationRevision)
    throw new Error("configuration revision changed during preparation; start a new deployment");
  await smokeImage(record);
  gate(record.sourceRevision);
  ensureSettled(machines(fly, app));
  const image = publish(fly, app, record);
  gate(record.sourceRevision);
  rollout(fly, app, image);
  const release = await verify(fly, app, image, record.sourceRevision);
  writeFileSync(
    path,
    `${JSON.stringify({ ...record, ...release, registryDigest: image.split("@")[1], deployedImage: image, deployedAt: new Date().toISOString() }, null, 2)}\n`,
    { mode: 0o600 },
  );
  console.log(`Deployed ${image} (source ${record.sourceRevision}); provenance: ${path}`);
}

try {
  await main();
} catch (error) {
  console.error(`Deployment failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  releaseLock();
}

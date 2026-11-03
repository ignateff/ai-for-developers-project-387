import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";
import { createContext, readApprovals } from "./docker-smoke-context.ts";

// CALENDAR_SMOKE_ROOT is a test seam: it selects the checkout under test instead of the repo.
const root = process.env.CALENDAR_SMOKE_ROOT ?? fileURLToPath(new URL("../", import.meta.url));
const recoveryDir =
  process.env.CALENDAR_SMOKE_RECOVERY_DIR ??
  join(homedir(), ".local", "state", "calendar-smoke-recoveries");
const reconcileBudget = Number(process.env.CALENDAR_SMOKE_RECONCILE_MS ?? 60_000);
if (!Number.isSafeInteger(reconcileBudget) || reconcileBudget <= 0)
  throw new Error("CALENDAR_SMOKE_RECONCILE_MS must be a positive integer");

const id = randomBytes(12).toString("hex");
const image = `calendar-smoke:${id}`;
const container = `calendar-smoke-${id}`;
const ownerLabel = "calendar.smoke.owner";
// This is a test marker, not a claim that the working tree equals a commit.
const revision = randomBytes(20).toString("hex");
const context = mkdtempSync(join(tmpdir(), "calendar-smoke-"));
const controller = new AbortController();
// pending: resources whose command was issued and which still need cleanup.
// uncertain: the client lost the answer; the daemon may finish the command late.
const pending = new Set<"image" | "container">();
const uncertain = new Set<"image" | "container">();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    controller.abort(new Error(`Interrupted by ${signal}`));
  });
}

type Resource = { kind: "image" | "container"; name: string };

function docker(args: string[], timeout = 30_000, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let killed = false;
    let killTimer: NodeJS.Timeout | undefined;
    const stop = () => {
      killed = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    };
    const timer = setTimeout(stop, timeout);
    signal?.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
      process.stderr.write(data);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", stop);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", stop);
      if (code === 0 && !killed) resolve(stdout.trim());
      else
        reject(
          new Error(
            `docker ${args[0]} failed${killed ? " or was interrupted (outcome may be unknown)" : ` (exit ${code})`}: ${stderr.trim()}`,
          ),
        );
    });
  });
}

async function buildImage(): Promise<void> {
  createContext(root, context, readApprovals(root));
  const version = readFileSync(join(context, "version.txt"), "utf8").trim();
  console.log(
    `Building working-copy snapshot for linux/amd64 (synthetic smoke marker ${revision.slice(0, 7)}; not a Git revision)`,
  );
  pending.add("image");
  uncertain.add("image");
  try {
    await docker(
      [
        "build",
        "--platform",
        "linux/amd64",
        "--build-arg",
        `APP_REVISION=${revision}`,
        "--label",
        `${ownerLabel}=${id}`,
        "-t",
        image,
        context,
      ],
      1_800_000,
      controller.signal,
    );
    uncertain.delete("image");
  } catch (error) {
    throw new Error("Image build did not complete cleanly", { cause: error });
  }
}

async function createContainer(): Promise<string> {
  pending.add("container");
  uncertain.add("container");
  try {
    const containerId = await docker(
      [
        "create",
        "--platform",
        "linux/amd64",
        "--name",
        container,
        "--label",
        `${ownerLabel}=${id}`,
        "-p",
        "127.0.0.1::8080",
        "-e",
        "PORT=8080",
        "-e",
        "DATABASE_PATH=:memory:",
        image,
      ],
      30_000,
      controller.signal,
    );
    uncertain.delete("container");
    return containerId;
  } catch (error) {
    throw new Error("Container creation did not complete cleanly", { cause: error });
  }
}

async function main(): Promise<void> {
  try {
    await docker(["info", "--format", "{{.ServerVersion}}"], 30_000, controller.signal);
  } catch (error) {
    throw new Error(
      "Docker is unavailable: install/start Docker and ensure its daemon is reachable",
      { cause: error },
    );
  }
  await buildImage();
  const version = readFileSync(join(context, "version.txt"), "utf8").trim();
  const containerId = await createContainer();
  await docker(["start", containerId], 30_000, controller.signal);
  const mapping = await docker(["port", containerId, "8080/tcp"], 30_000, controller.signal);
  const port = /127\.0\.0\.1:(\d+)$/.exec(mapping)?.[1];
  if (!port) throw new Error(`Unexpected Docker port mapping: ${mapping}`);
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  let healthy = false;
  while (Date.now() < deadline) {
    controller.signal.throwIfAborted();
    try {
      const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2_000) });
      if (response.status === 200 && JSON.stringify(await response.json()) === '{"status":"ok"}') {
        healthy = true;
        break;
      }
    } catch {
      // Startup may not have completed yet.
    }
    await delay(500, undefined, { signal: controller.signal });
  }
  if (!healthy)
    throw new Error(
      'Container health did not return HTTP 200 and {"status":"ok"} within 60 seconds',
    );
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    const messages: string[] = [];
    const assets: { url: string; status: number }[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
      if (message.type() === "info" && message.text().startsWith("Calendar v"))
        messages.push(message.text());
    });
    page.on("response", (response) => {
      if (response.request().resourceType() === "script")
        assets.push({ url: response.url(), status: response.status() });
    });
    const response = await page.goto(base, { waitUntil: "networkidle", timeout: 30_000 });
    if (response?.status() !== 200)
      throw new Error(`Root page returned ${response?.status() ?? "no response"}`);
    await page
      .getByRole("navigation", { name: "Основная навигация" })
      .waitFor({ state: "visible", timeout: 10_000 });
    controller.signal.throwIfAborted();
    const expected = `Calendar v${version} (${revision.slice(0, 7)})`;
    if (JSON.stringify(messages) !== JSON.stringify([expected]))
      throw new Error(
        `Expected exact production message ${expected}; got ${JSON.stringify(messages)}`,
      );
    if (!assets.length || assets.some((asset) => asset.status !== 200))
      throw new Error(`Frontend script assets failed: ${JSON.stringify(assets)}`);
    if (errors.length) throw new Error(`Browser JavaScript errors: ${errors.join("; ")}`);
    console.log(
      `Production smoke passed: health, root, ${assets.length} script asset(s), and ${expected}`,
    );
  } finally {
    await browser.close();
  }
}

async function inspectResource(resource: Resource): Promise<unknown> {
  const output = await docker(
    [resource.kind, "inspect", "--format", "{{json .}}", resource.name],
    30_000,
  );
  return JSON.parse(output);
}

// Remove only after ownership is proven by the run-specific label and a
// well-formed ID. Returns false when the resource is absent; anything
// unverifiable throws and is never deleted.
async function removeOwned(resource: Resource): Promise<boolean> {
  let inspected: unknown;
  try {
    inspected = await inspectResource(resource);
  } catch {
    return false;
  }
  const record = inspected as {
    Id?: unknown;
    Config?: { Labels?: Record<string, unknown> };
  };
  if (record?.Config?.Labels?.[ownerLabel] !== id)
    throw new Error(
      `Docker ${resource.kind} ${resource.name} has no matching ${ownerLabel} label; left untouched`,
    );
  const resourceId = record.Id;
  const idPattern = resource.kind === "container" ? /^[a-f0-9]{64}$/ : /^sha256:[a-f0-9]{64}$/;
  if (typeof resourceId !== "string" || !idPattern.test(resourceId))
    throw new Error(
      `Docker ${resource.kind} ${resource.name} returned an invalid ID; left untouched`,
    );
  await docker(
    resource.kind === "container" ? ["rm", "-f", resourceId] : ["image", "rm", resourceId],
    30_000,
  );
  console.error(`Removed owned Docker ${resource.kind} ${resource.name}`);
  return true;
}

function recoveryRecordPath(recordId: string): string {
  if (!/^[a-f0-9]{24}$/.test(recordId)) throw new Error("Invalid recovery record id");
  return join(recoveryDir, `${recordId}.json`);
}

function writeRecoveryRecord(unresolved: Resource[]): string {
  mkdirSync(recoveryDir, { recursive: true });
  const path = recoveryRecordPath(id);
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        runId: id,
        createdAt: new Date().toISOString(),
        root,
        owner: id,
        label: ownerLabel,
        resources: unresolved,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return path;
}

function readRecoveryRecord(path: string): {
  runId: string;
  owner: string;
  label: string;
  resources: Resource[];
} {
  const record: unknown = JSON.parse(readFileSync(path, "utf8"));
  const candidate = record as {
    runId?: unknown;
    owner?: unknown;
    label?: unknown;
    resources?: unknown;
  };
  const validResource = (value: unknown): value is Resource =>
    typeof value === "object" &&
    value !== null &&
    ((value as Resource).kind === "image" || (value as Resource).kind === "container") &&
    /^calendar-smoke[-:][a-f0-9]{24}$/.test((value as Resource).name);
  if (
    typeof candidate.runId !== "string" ||
    !/^[a-f0-9]{24}$/.test(candidate.runId) ||
    candidate.owner !== candidate.runId ||
    candidate.label !== ownerLabel ||
    !Array.isArray(candidate.resources) ||
    !candidate.resources.every(validResource) ||
    !candidate.resources.every(
      (resource) =>
        resource.name === `calendar-smoke:${candidate.runId}` ||
        resource.name === `calendar-smoke-${candidate.runId}`,
    )
  )
    throw new Error(`Invalid smoke recovery record: ${path}`);
  return candidate as { runId: string; owner: string; label: string; resources: Resource[] };
}

// Bounded reconciliation. An uncertain command may complete on the daemon after
// the client stopped waiting, so absence in a single inspection is not proof:
// poll within the budget and remove the resource only if it appears owned. A
// resource still absent at the deadline is unresolved, not cleaned.
async function reconcile(): Promise<Resource[]> {
  const attempted: Resource[] = [];
  if (pending.has("container")) attempted.push({ kind: "container", name: container });
  if (pending.has("image")) attempted.push({ kind: "image", name: image });
  const unresolved: Resource[] = [];
  for (const resource of attempted) {
    try {
      if (!uncertain.has(resource.kind)) {
        if (await removeOwned(resource)) pending.delete(resource.kind);
        else unresolved.push(resource);
        continue;
      }
      const deadline = Date.now() + reconcileBudget;
      let removed = false;
      while (Date.now() < deadline && !removed) {
        removed = await removeOwned(resource);
        if (!removed) await delay(500);
      }
      if (removed) pending.delete(resource.kind);
      else unresolved.push(resource);
    } catch (error) {
      console.error(error);
      unresolved.push(resource);
    }
  }
  return unresolved;
}

async function recover(path: string): Promise<void> {
  const record = readRecoveryRecord(path);
  let remaining = [...record.resources];
  const leftover: Resource[] = [];
  for (const resource of record.resources) {
    let inspected: unknown;
    try {
      inspected = await inspectResource(resource);
    } catch {
      leftover.push(resource);
      console.error(
        `Docker ${resource.kind} ${resource.name}: unresolved; inspection failed or the daemon may still create it`,
      );
      continue;
    }
    const details = inspected as { Id?: unknown; Config?: { Labels?: Record<string, unknown> } };
    if (
      details?.Config?.Labels?.[record.label] !== record.owner ||
      typeof details.Id !== "string" ||
      !(resource.kind === "container" ? /^[a-f0-9]{64}$/ : /^sha256:[a-f0-9]{64}$/).test(details.Id)
    ) {
      leftover.push(resource);
      console.error(
        `Docker ${resource.kind} ${resource.name}: ownership does not match the record; left untouched`,
      );
      continue;
    }
    await docker(
      resource.kind === "container" ? ["rm", "-f", details.Id] : ["image", "rm", details.Id],
      30_000,
    );
    remaining = remaining.filter((item) => item !== resource);
    // Persist confirmed progress atomically before trying another resource.
    // An empty resource list means every recorded removal was acknowledged;
    // a later recovery can finish unlinking if this process is interrupted.
    const progressPath = `${path}.${id}.tmp`;
    try {
      writeFileSync(
        progressPath,
        `${JSON.stringify({ ...record, resources: remaining }, null, 2)}\n`,
        { mode: 0o600, flag: "wx" },
      );
      renameSync(progressPath, path);
    } finally {
      rmSync(progressPath, { force: true });
    }
    console.error(`Docker ${resource.kind} ${resource.name}: removed after late completion`);
  }
  if (leftover.length) {
    throw new Error(
      `Recovery unresolved; some recorded resources remain unverified: ${leftover.map((item) => item.name).join(", ")}`,
    );
  }
  unlinkSync(path);
  console.error(`Recovery record ${path} cleared`);
}

const recoverIndex = process.argv.indexOf("recover");
if (recoverIndex !== -1) {
  const recordPath = process.argv[recoverIndex + 1];
  if (!recordPath) {
    console.error("Usage: node scripts/docker-smoke.ts recover <recovery-record-path>");
    process.exitCode = 1;
  } else {
    try {
      await recover(recordPath);
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    }
  }
} else {
  let failure: unknown;
  try {
    await main();
  } catch (error) {
    failure = error;
    console.error(error);
    process.exitCode = 1;
  }
  const unresolved = await reconcile();
  if (unresolved.length) {
    const record = writeRecoveryRecord(unresolved);
    console.error(
      `Unresolved Docker resources: the daemon may complete ${unresolved
        .map((item) => item.name)
        .join(", ")} late, so their absence is not proven. ` +
        `Recovery record: ${record}. After checking the daemon, run: node scripts/docker-smoke.ts recover ${record}`,
    );
    process.exitCode = 1;
  }
  if (existsSync(context)) rmSync(context, { recursive: true, force: true });
  if (failure || unresolved.length) process.exitCode = 1;
}

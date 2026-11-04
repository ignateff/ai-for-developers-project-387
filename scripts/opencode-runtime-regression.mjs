import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { createCommandEnvironment, assertCommandAgent } from "./opencode-command.ts";
import { installRuntime, runtimeVersion, verifyInstalledRuntime } from "./opencode-install.ts";
import { assertSafeProject } from "./opencode-discovery.ts";

const execute = promisify(execFile);
const root = await realpath(await mkdtemp(join(tmpdir(), "calendar-oc-regression-")));
const sentinel = "REAL_PERMISSION_SERVICE_SENTINEL";

async function bounded(promise, label, milliseconds = 20000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`OpenCode regression deadline: ${label}`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function probe(binary, scenario) {
  const directory = join(root, scenario);
  const project = join(directory, "project");
  const outside = join(directory, "outside");
  const runtime = join(directory, "runtime");
  const env = createCommandEnvironment({
    workspace: project,
    directory: runtime,
    base: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  const configDirectory = join(env.XDG_CONFIG_HOME, "opencode");
  for (const path of [project, outside, env.TMPDIR, join(configDirectory, "node_modules")])
    await mkdir(path, { recursive: true });
  // Pure test runtime does not import the SDK. Skip its otherwise unnecessary
  // npm reify, using the same empty-package fixture as upstream's config tests.
  await writeFile(
    join(configDirectory, "package-lock.json"),
    JSON.stringify({
      lockfileVersion: 3,
      packages: { "": { dependencies: { "@opencode-ai/plugin": runtimeVersion } } },
    }),
  );
  await writeFile(join(project, "AGENTS.md"), "# Fixture\nUse the agreed permission policy.\n");
  await writeFile(join(runtime, "instructions.md"), "No external credentials or real model.\n");
  let target = join(outside, "fixture.txt");
  if (scenario === "allowed-temp" || scenario === "write-temp")
    target = join(env.TMPDIR, "fixture.txt");
  if (scenario === "secret-read") target = join(project, ".env");
  if (scenario === "example-read") target = join(project, ".env.example");
  await writeFile(target, `${sentinel}\n`);
  const marker = join(outside, "shell-ran");
  const toolName =
    scenario === "blocked-task"
      ? "task"
      : scenario === "write-temp"
        ? "write"
        : scenario === "external-shell"
          ? "bash"
          : "read";
  const input =
    toolName === "write"
      ? { filePath: target, content: "verified write\n" }
      : toolName === "bash"
        ? { command: "touch shell-ran", workdir: outside, description: "Fixture must be denied" }
        : toolName === "task"
          ? { description: "Must not delegate", prompt: "Do not run", subagent_type: "explore" }
          : { filePath: target };
  let requests = 0;
  let instructionsSeen = false;
  const llm = createServer(async (request, response) => {
    try {
      assert.equal(request.url, "/v1/chat/completions");
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      instructionsSeen ||= JSON.stringify(body.messages).includes(
        "Use the agreed permission policy.",
      );
      requests++;
      const completed = body.messages.some((message) => message.role === "tool");
      const chunk = (delta, finish = null) => ({
        id: "chatcmpl-fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "fixture",
        choices: [{ index: 0, delta, finish_reason: finish }],
      });
      const events = completed
        ? [chunk({ role: "assistant" }), chunk({ content: "fixture complete" }), chunk({}, "stop")]
        : [
            chunk({ role: "assistant" }),
            chunk({
              tool_calls: [
                {
                  index: 0,
                  id: "call_fixture",
                  type: "function",
                  function: { name: toolName, arguments: JSON.stringify(input) },
                },
              ],
            }),
            chunk({}, "tool_calls"),
          ];
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
      response.end("data: [DONE]\n\n");
    } catch {
      response.writeHead(500);
      response.end();
    }
  });
  await new Promise((resolve) => llm.listen(0, "127.0.0.1", resolve));
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
  if (scenario === "baseline-ask") {
    delete config.permission;
    delete config.agent;
  }
  config.model = config.small_model = "fixture/fixture";
  config.provider = {
    fixture: {
      name: "Fixture",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        fixture: { name: "Fixture", tool_call: true, limit: { context: 100000, output: 10000 } },
      },
      options: { apiKey: "not-a-real-key", baseURL: `http://127.0.0.1:${llm.address().port}/v1` },
    },
  };
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
  env.OPENCODE_DISABLE_MODELS_FETCH = "1";
  env.OPENCODE_DISABLE_AUTOCOMPACT = "1";
  await assertSafeProject(project);
  if (scenario !== "baseline-ask") {
    const { stdout } = await execute(binary, ["debug", "agent", "build"], {
      cwd: project,
      env,
      encoding: "utf8",
      timeout: 20000,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
    });
    assertCommandAgent(JSON.parse(stdout), { workspace: project, directory: runtime });
  }
  const runtimeProcess = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: project,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise((resolve, reject) => {
    runtimeProcess.once("close", resolve);
    runtimeProcess.once("error", reject);
  });
  let output = "";
  const listening = new Promise((resolve, reject) => {
    runtimeProcess.stdout.on("data", (data) => {
      output += data;
      const match = output.match(/listening on (http:\/\/[^\s]+)/);
      if (match) resolve(match[1]);
    });
    runtimeProcess.once("close", () =>
      reject(new Error("Fixture runtime exited before listening")),
    );
    runtimeProcess.once("error", reject);
  });
  // Consume stderr but do not publish arbitrary environment/configuration output.
  runtimeProcess.stderr.resume();
  const eventsController = new AbortController();
  let eventReader;
  try {
    const url = await bounded(listening, "server startup");
    const headers = { "x-opencode-directory": project, "content-type": "application/json" };
    const request = async (path, method = "GET", body) => {
      const response = await fetch(`${url}${path}`, {
        method,
        headers,
        signal: AbortSignal.timeout(20000),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      assert.equal(response.status, 200, `Fixture API ${method} ${path}`);
      return response.json();
    };
    assert.equal((await request("/global/health")).version, runtimeVersion);
    const session = await request("/session", "POST", {
      title: `Permission regression ${scenario}`,
      permission: [{ permission: "question", pattern: "*", action: "deny" }],
    });
    const events = [];
    let resolveAsked, resolveConnected;
    const asked = new Promise((resolve) => {
      resolveAsked = resolve;
    });
    const connected = new Promise((resolve) => {
      resolveConnected = resolve;
    });
    const stream = await fetch(`${url}/event`, { headers, signal: eventsController.signal });
    const reader = stream.body.getReader();
    eventReader = (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let end;
        while ((end = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (!data) continue;
          const event = JSON.parse(data);
          events.push(event);
          if (event.type === "server.connected") resolveConnected();
          if (event.type === "permission.asked" && event.properties.sessionID === session.id)
            resolveAsked(event);
        }
      }
    })().catch((error) => {
      if (error.name !== "AbortError") throw error;
    });
    await bounded(connected, "event stream startup");
    let settled = false;
    const prompt = request(`/session/${session.id}/message`, "POST", {
      model: { providerID: "fixture", modelID: "fixture" },
      agent: "build",
      parts: [{ type: "text", text: "Execute the single fixture operation." }],
    }).finally(() => {
      settled = true;
    });
    // Attach a rejection observer even if a separate assertion fails first.
    void prompt.catch(() => {});
    if (scenario === "baseline-ask") {
      const event = await bounded(asked, "baseline permission request");
      assert.equal(event.properties.permission, "external_directory");
      assert.equal((await request("/permission")).length, 1);
      await delay(300);
      assert.equal(
        settled,
        false,
        "baseline must actually remain pending after provider completion",
      );
      assert.equal(requests, 1);
      assert.equal((await request("/permission"))[0].id, event.properties.id);
      await request(`/permission/${event.properties.id}/reply`, "POST", { reply: "once" });
    }
    await bounded(prompt, "tool completion");
    const messages = await request(`/session/${session.id}/message`);
    const tools = messages
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "tool");
    assert.equal(tools.length, 1);
    if (scenario !== "blocked-task") assert.equal(tools[0].tool, toolName);
    const denied = ["denied-external", "secret-read", "external-shell", "blocked-task"].includes(
      scenario,
    );
    assert.equal(tools[0].state.status, denied ? "error" : "completed");
    if (denied) {
      assert.match(
        tools[0].state.error,
        scenario === "blocked-task"
          ? /denied|invalid|not found|prevents/i
          : /specified a rule which prevents/,
      );
      assert.ok(!JSON.stringify(messages).includes(sentinel));
    } else if (toolName === "read") assert.ok(tools[0].state.output.includes(sentinel));
    if (scenario === "write-temp") assert.equal(await readFile(target, "utf8"), "verified write\n");
    if (scenario === "external-shell") await assert.rejects(access(marker));
    if (scenario === "blocked-task")
      assert.equal((await request("/session")).length, 1, "no child session may start");
    assert.ok(
      instructionsSeen,
      "explicit repository instructions must survive project discovery disablement",
    );
    assert.deepEqual(await request("/permission"), []);
    assert.equal(
      events.filter((event) => event.type === "permission.asked").length,
      scenario === "baseline-ask" ? 1 : 0,
    );
    console.log(`PASS: ${scenario} (${tools[0].state.status}, no unresolved permissions)`);
  } finally {
    eventsController.abort();
    try {
      if (eventReader) await bounded(eventReader, "event stream shutdown", 5000);
    } finally {
      try {
        if (
          runtimeProcess.exitCode === null &&
          runtimeProcess.signalCode === null &&
          runtimeProcess.pid
        ) {
          try {
            process.kill(-runtimeProcess.pid, "SIGTERM");
          } catch (error) {
            if (error.code !== "ESRCH") throw error;
          }
        }
        try {
          await bounded(exited, "runtime shutdown", 5000);
        } catch {
          try {
            process.kill(-runtimeProcess.pid, "SIGKILL");
          } catch (error) {
            if (error.code !== "ESRCH") throw error;
          }
          await bounded(exited, "runtime forced shutdown", 5000);
        }
      } finally {
        llm.closeAllConnections();
        await new Promise((resolve, reject) =>
          llm.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }
  }
}

async function probeAdapter(archivePath) {
  const project = join(root, "adapter-project");
  const directory = join(root, "adapter-state");
  await mkdir(project);
  await writeFile(
    join(project, "AGENTS.md"),
    "# Adapter fixture\nNo real model or GitHub credentials.\n",
  );
  const event = join(root, "adapter-event.json");
  await writeFile(
    event,
    JSON.stringify({
      action: "created",
      issue: { number: 9 },
      repository: { full_name: "fixture/repo", owner: { login: "fixture" } },
      comment: { body: "/oc fix this", user: { login: "fixture" } },
    }),
  );
  const env = {
    PATH: process.env.PATH,
    HOME: join(root, "adapter-home"),
    GITHUB_WORKSPACE: project,
    OPENCODE_COMMAND_DIR: directory,
    GITHUB_EVENT_PATH: event,
    GITHUB_EVENT_NAME: "issue_comment",
    GITHUB_REPOSITORY: "fixture/repo",
    GITHUB_REPOSITORY_OWNER: "fixture",
    GITHUB_ACTOR: "fixture",
    GITHUB_RUN_ID: "1",
    GITHUB_ACTIONS: "true",
  };
  // Network and unused SDK-install fixtures only; the adapter still authenticates
  // the real release bytes and inspects the actual native build agent.
  const hook = `import {readFile,mkdir,writeFile} from 'node:fs/promises';
    import {join} from 'node:path';
    globalThis.fetch = async (url) => {
      if (!String(url).startsWith('https://github.com/anomalyco/opencode/releases/download/v${runtimeVersion}/'))
        throw new Error('Fixture forbids external requests');
      const config = join(process.env.OPENCODE_COMMAND_DIR, 'home/.config/opencode');
      await mkdir(join(config, 'node_modules'), {recursive:true});
      await writeFile(join(config, 'package-lock.json'), JSON.stringify({lockfileVersion:3,packages:{'':{dependencies:{'@opencode-ai/plugin':'${runtimeVersion}'}}}}));
      return new Response(new Uint8Array(await readFile(${JSON.stringify(archivePath)})));
    };`;
  const script = join(import.meta.dirname, "opencode-command.ts");
  const prepared = await execute(
    process.execPath,
    ["--import", `data:text/javascript,${encodeURIComponent(hook)}`, script, "prepare"],
    {
      env,
      encoding: "utf8",
      timeout: 60000,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
    },
  );
  assert.match(prepared.stdout, /effective command policy is noninteractive/);
  const state = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
  assert.equal(state.version, runtimeVersion);
  await verifyInstalledRuntime(state.binary);
  // No OIDC request URL/token exists in this local fixture. The real upstream
  // handler must fail, and the adapter must propagate failure instead of success.
  const failed = await execute(process.execPath, [script, "run"], {
    env: { ...env, DEEPSEEK_API_KEY: "not-a-real-key" },
    encoding: "utf8",
    timeout: 60000,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
  }).then(
    () => null,
    (error) => error,
  );
  assert.equal(failed?.code, 1);
  assert.match(failed.stderr, /handler failed or was cancelled; fix is not confirmed/);
  assert.ok(!failed.stdout.includes("Created PR"));
  console.log("PASS: real adapter prepare and upstream failure propagation (no OIDC credentials)");
}

try {
  // Optional offline public artifact; the production checksum is still mandatory.
  const archive = process.env.CALENDAR_OPENCODE_ARCHIVE;
  const archivePath = join(root, "release.archive");
  const binary = await installRuntime({
    directory: join(root, "binary"),
    fetch: async (url, options) => {
      const response = archive
        ? new Response(new Uint8Array(await readFile(archive)))
        : await fetch(url, options);
      if (!response.ok) return response;
      const bytes = new Uint8Array(
        await bounded(response.arrayBuffer(), "artifact download", 120000),
      );
      await writeFile(archivePath, bytes, { mode: 0o600 });
      return new Response(bytes);
    },
  });
  await verifyInstalledRuntime(binary);
  for (const scenario of [
    "baseline-ask",
    "denied-external",
    "allowed-temp",
    "secret-read",
    "example-read",
    "write-temp",
    "external-shell",
    "blocked-task",
  ])
    await probe(binary, scenario);
  await probeAdapter(archivePath);
  await rm(root, { recursive: true, force: true });
} catch (error) {
  console.error(`OpenCode regression failed; isolated fixture retained at ${root}`);
  throw error;
}

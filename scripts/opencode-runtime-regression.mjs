import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { access, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import {
  createCommandEnvironment,
  assertCommandAgent,
  commandSubagents,
} from "./opencode-command.ts";
import { formatRuntimeLogSummary, summarizeRuntimeLog } from "./opencode-log-summary.ts";
import { installRuntime, runtimeVersion, verifyInstalledRuntime } from "./opencode-install.ts";
import { assertSafeProject } from "./opencode-discovery.ts";
import { commandSkills, verifyCommandSkills } from "./opencode-skills.ts";

const execute = promisify(execFile);
const root = await realpath(await mkdtemp(join(tmpdir(), "calendar-oc-regression-")));
const sentinel = "REAL_PERMISSION_SERVICE_SENTINEL";
const skills = commandSkills;

async function skillFixture(project, runtime, prepare = true) {
  await mkdir(join(project, "scripts"), { recursive: true });
  await cp(
    join(import.meta.dirname, "matt-skills-sha256.json"),
    join(project, "scripts/matt-skills-sha256.json"),
  );
  for (const name of skills)
    await cp(
      join(import.meta.dirname, "..", ".agents/skills", name),
      join(project, ".agents/skills", name),
      { recursive: true },
    );
  if (prepare) {
    await verifyCommandSkills(project, runtime, true);
    await verifyCommandSkills(project, runtime, false);
  }
}

async function probeSkills(binary) {
  const project = join(root, "skills-project");
  const runtime = join(root, "skills-runtime");
  await skillFixture(project, runtime);
  await execute("git", ["init", "-q", project]);
  const env = createCommandEnvironment({
    workspace: project,
    directory: runtime,
    base: { PATH: process.env.PATH },
  });
  await mkdir(env.TMPDIR, { recursive: true });
  env.OPENCODE_DISABLE_MODELS_FETCH = "1";
  const discover = async (environment) =>
    JSON.parse(
      (
        await execute(binary, ["debug", "skill"], {
          cwd: project,
          env: environment,
          timeout: 30000,
          maxBuffer: 2 * 1024 * 1024,
        })
      ).stdout,
    );
  const clean = { ...env };
  delete clean.OPENCODE_DISABLE_EXTERNAL_SKILLS;
  delete clean.OPENCODE_DISABLE_CLAUDE_CODE;
  const cleanConfig = JSON.parse(clean.OPENCODE_CONFIG_CONTENT);
  delete cleanConfig.skills;
  cleanConfig.permission.skill = "allow";
  cleanConfig.agent.build.permission.skill = "allow";
  clean.OPENCODE_CONFIG_CONTENT = JSON.stringify(cleanConfig);
  const found = await discover(clean);
  for (const name of skills) {
    const entry = found.find((item) => item.name === name);
    assert.equal(
      entry?.location,
      join(project, ".agents", "skills", name, "SKILL.md"),
      `clean discovery: ${name}`,
    );
  }
  const restricted = await discover(env);
  for (const name of skills) {
    const entry = restricted.find((item) => item.name === name);
    assert.equal(entry?.location, join(runtime, "skills", name, "SKILL.md"));
  }
  console.log("PASS: clean discovery and isolated command skill discovery");
}

async function probeDelegation(binary) {
  const directory = join(root, "delegation");
  const project = join(directory, "project");
  const outside = join(directory, "outside");
  const runtime = join(directory, "runtime");
  const sentinel = "DELEGATION_FIXTURE_SENTINEL";
  const env = createCommandEnvironment({
    workspace: project,
    directory: runtime,
    base: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      // Fixture values only; never real credentials.
      GH_TOKEN: "fixture-token-not-real",
      DEEPSEEK_API_KEY: "fixture-key-not-real",
    },
  });
  const configDirectory = join(env.XDG_CONFIG_HOME, "opencode");
  for (const path of [project, outside, env.TMPDIR, join(configDirectory, "node_modules")])
    await mkdir(path, { recursive: true });
  await execute("git", ["init", "-q", project]);
  await writeFile(join(project, "AGENTS.md"), "# Fixture\nUse the agreed policy.\n");
  await writeFile(join(runtime, "instructions.md"), "No real credentials.\n");
  await writeFile(join(project, ".env"), `${sentinel}\n`);
  await writeFile(join(outside, "secret.txt"), `${sentinel}\n`);
  await writeFile(join(project, "edit-target.txt"), "original\n");
  await writeFile(join(project, "read-target.txt"), "readable fixture\n");
  await writeFile(
    join(configDirectory, "package-lock.json"),
    JSON.stringify({
      lockfileVersion: 3,
      packages: { "": { dependencies: { "@opencode-ai/plugin": runtimeVersion } } },
    }),
  );
  for (const [key, value] of [
    ["user.email", "fixture@example.invalid"],
    ["user.name", "Fixture"],
  ])
    await execute("git", ["config", key, value], { cwd: project });
  await execute("git", ["add", "-A"], { cwd: project });
  await execute("git", ["commit", "-qm", "fixture baseline"], { cwd: project });

  // Resolve every configured agent exactly as preparation does; this fails if the
  // pinned runtime disagrees with the approved implementer/reviewer policy.
  const inspection = { ...env };
  for (const key of ["DEEPSEEK_API_KEY", "GH_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"])
    delete inspection[key];
  await assertSafeProject(project);
  for (const name of ["build", ...commandSubagents]) {
    const { stdout } = await execute(binary, ["debug", "agent", name], {
      cwd: project,
      env: inspection,
      encoding: "utf8",
      timeout: 30000,
      killSignal: "SIGKILL",
      maxBuffer: 2 * 1024 * 1024,
    });
    assertCommandAgent(JSON.parse(stdout), { workspace: project, directory: runtime }, name);
  }

  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
  config.model = config.small_model = "fixture/fixture";
  config.provider = {
    fixture: {
      name: "Fixture",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        fixture: { name: "Fixture", tool_call: true, limit: { context: 100000, output: 10000 } },
      },
      options: { apiKey: "not-a-real-key", baseURL: "http://127.0.0.1:0/v1" },
    },
  };
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
  env.OPENCODE_DISABLE_MODELS_FETCH = "1";
  env.OPENCODE_DISABLE_AUTOCOMPACT = "1";

  const telemetry = { childTools: {}, permissionAsks: [] };
  const chunk = (delta, finish = null) => ({
    id: "chatcmpl-fixture",
    object: "chat.completion.chunk",
    created: 1,
    model: "fixture",
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  const toolChunk = (items) =>
    chunk({
      role: "assistant",
      tool_calls: items.map((item, index) => ({
        index,
        id: item.id,
        type: "function",
        function: { name: item.name, arguments: JSON.stringify(item.args) },
      })),
    });
  const respond = (response, items) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const item of items) response.write(`data: ${JSON.stringify(item)}\n\n`);
    response.end("data: [DONE]\n\n");
  };
  const done = [
    chunk({ role: "assistant" }),
    chunk({ content: "fixture complete" }),
    chunk({}, "stop"),
  ];
  const taskCall = (id, subagentType, prompt, description) => ({
    id,
    name: "task",
    args: { description, prompt, subagent_type: subagentType },
  });
  const readCall = (id, path) => ({ id, name: "read", args: { filePath: path } });
  const editCall = (id, path) => ({
    id,
    name: "edit",
    args: { filePath: path, oldString: "original", newString: "edited by implementer" },
  });
  const bashCall = (id, command) => ({
    id,
    name: "bash",
    args: {
      command:
        command ??
        'test -n "$GH_TOKEN" && echo GH_TOKEN_PRESENT; test -n "$DEEPSEEK_API_KEY" && echo DEEPSEEK_API_KEY_PRESENT; pwd',
      description: "fixture command",
      workdir: project,
    },
  });

  const llm = createServer(async (request, response) => {
    try {
      assert.equal(request.url, "/v1/chat/completions");
      const buffers = [];
      for await (const item of request) buffers.push(item);
      const body = JSON.parse(Buffer.concat(buffers).toString());
      const tools = (body.tools ?? [])
        .map((tool) => tool.function?.name ?? tool.name)
        .filter(Boolean);
      const text = (body.messages ?? [])
        .filter((message) => message.role === "user")
        .map((message) =>
          typeof message.content === "string"
            ? message.content
            : (message.content ?? []).map((part) => part.text ?? "").join(""),
        )
        .join("\n");
      const toolResults = (body.messages ?? []).filter((message) => message.role === "tool").length;
      const route = tools.includes("task")
        ? "parent"
        : tools.includes("bash") && tools.includes("edit")
          ? "implementer"
          : tools.includes("read")
            ? "reviewer"
            : "unknown";
      if (route !== "parent") telemetry.childTools[route] = tools.sort();
      const tag = (name) => text.includes(name);
      if (route === "parent") {
        if (toolResults > 0) return respond(response, done);
        if (tag("SCENARIO:delegation"))
          return respond(response, [
            chunk({ role: "assistant" }),
            toolChunk([
              taskCall(
                "call_impl",
                "implementer",
                "IMPLEMENTER: edit and run",
                "delegate implement",
              ),
              taskCall("call_rread", "reviewer", "REVIEWER-READ: inspect", "review read"),
              taskCall("call_redit", "reviewer", "REVIEWER-EDIT: edit", "review edit"),
              taskCall("call_rbash", "reviewer", "REVIEWER-BASH: shell", "review bash"),
              taskCall("call_rtask", "reviewer", "REVIEWER-TASK: delegate", "review nested"),
            ]),
            chunk({}, "tool_calls"),
          ]);
        if (tag("SCENARIO:deny"))
          return respond(response, [
            chunk({ role: "assistant" }),
            toolChunk([
              taskCall("call_ok", "implementer", "IMPLEMENTER: edit and run", "allowed"),
              taskCall("call_bad", "not-a-real-agent", "FORBIDDEN: unknown type", "invalid type"),
              taskCall("call_general", "general", "FORBIDDEN: built-in", "not allowlisted"),
            ]),
            chunk({}, "tool_calls"),
          ]);
        if (tag("SCENARIO:parallel"))
          return respond(response, [
            chunk({ role: "assistant" }),
            toolChunk(
              [1, 2, 3].map((index) =>
                taskCall(
                  `call_p_${index}`,
                  "implementer",
                  `IMPLEMENTER-SLOW-${index}: slow fixture work`,
                  `slow implement ${index}`,
                ),
              ),
            ),
            chunk({}, "tool_calls"),
          ]);
        return respond(response, done);
      }
      if (route === "implementer") {
        if (tag("IMPLEMENTER-SLOW")) {
          await new Promise((resolve) => setTimeout(resolve, 800));
          return respond(response, done);
        }
        if (toolResults === 0)
          return respond(response, [
            chunk({ role: "assistant" }),
            toolChunk([editCall("call_i_edit", join(project, "edit-target.txt"))]),
            chunk({}, "tool_calls"),
          ]);
        if (toolResults === 1)
          return respond(response, [
            chunk({ role: "assistant" }),
            toolChunk([bashCall("call_i_bash")]),
            chunk({}, "tool_calls"),
          ]);
        if (toolResults === 2)
          return respond(response, [
            chunk({ role: "assistant" }),
            toolChunk([
              bashCall(
                "call_i_worktree",
                'git worktree add "$TMPDIR/ticket-worktree" -b ticket-worktree && test -f "$TMPDIR/ticket-worktree/AGENTS.md" && git worktree remove --force "$TMPDIR/ticket-worktree" && git branch -D ticket-worktree',
              ),
            ]),
            chunk({}, "tool_calls"),
          ]);
        return respond(response, done);
      }
      if (route === "reviewer") {
        const sequences = {
          "REVIEWER-READ": [
            readCall("call_r_read", join(project, "read-target.txt")),
            readCall("call_r_env", join(project, ".env")),
            readCall("call_r_outside", join(outside, "secret.txt")),
          ],
          "REVIEWER-EDIT": [editCall("call_r_edit", join(project, "edit-target.txt"))],
          "REVIEWER-BASH": [bashCall("call_r_bash")],
          "REVIEWER-TASK": [
            taskCall("call_r_task", "implementer", "IMPLEMENTER: nested", "nested"),
          ],
        };
        const key = Object.keys(sequences).find((name) => tag(name));
        const sequence = key ? sequences[key] : [];
        if (toolResults < sequence.length)
          return respond(response, [
            chunk({ role: "assistant" }),
            toolChunk([sequence[toolResults]]),
            chunk({}, "tool_calls"),
          ]);
        return respond(response, done);
      }
      return respond(response, done);
    } catch {
      response.writeHead(500);
      response.end();
    }
  });
  await new Promise((resolve) => llm.listen(0, "127.0.0.1", resolve));
  env.OPENCODE_CONFIG_CONTENT = env.OPENCODE_CONFIG_CONTENT.replace(
    "http://127.0.0.1:0/v1",
    `http://127.0.0.1:${llm.address().port}/v1`,
  );

  const runtimeProcess = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: project,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  runtimeProcess.stderr.resume();
  const exited = new Promise((resolve, reject) => {
    runtimeProcess.once("close", resolve);
    runtimeProcess.once("error", reject);
  });
  const url = await new Promise((resolve, reject) => {
    let output = "";
    runtimeProcess.stdout.on("data", (data) => {
      output += data;
      const match = output.match(/listening on (http:\/\/[^\s]+)/);
      if (match) resolve(match[1]);
    });
    runtimeProcess.once("close", () =>
      reject(new Error("Fixture runtime exited before listening")),
    );
    runtimeProcess.once("error", reject);
    setTimeout(() => reject(new Error("Fixture runtime startup timeout")), 30000).unref();
  });
  const headers = {
    "x-opencode-directory": project,
    "content-type": "application/json",
    connection: "close",
  };
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
  const events = [];
  const controller = new AbortController();
  const stream = await fetch(`${url}/event`, { headers, signal: controller.signal });
  const reader = stream.body.getReader();
  const readerLoop = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done: finished, value } = await reader.read();
      if (finished) return;
      buffer += decoder.decode(value, { stream: true });
      let end;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");
        if (!data) continue;
        const event = JSON.parse(data);
        events.push(event);
        if (event.type === "permission.asked") telemetry.permissionAsks.push(event);
      }
    }
  })().catch((error) => {
    if (error.name !== "AbortError") throw error;
  });
  await new Promise((resolve) => setTimeout(resolve, 500));

  const toolParts = (messages) =>
    messages.flatMap((message) => message.parts ?? []).filter((part) => part.type === "tool");
  const runScenario = async (name, marker) => {
    const session = await request("/session", "POST", { title: `Fixture ${name}` });
    let observed = 0;
    let polling = true;
    const poll = (async () => {
      while (polling) {
        const sessions = await request("/session");
        observed = Math.max(
          observed,
          sessions.filter((item) => item.parentID === session.id).length,
        );
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
    })().catch(() => {});
    const prompt = await request(`/session/${session.id}/message`, "POST", {
      model: { providerID: "fixture", modelID: "fixture" },
      agent: "build",
      parts: [{ type: "text", text: `${marker} run the fixture steps` }],
    });
    polling = false;
    await poll;
    assert.ok(prompt);
    const sessions = await request("/session");
    const children = sessions.filter((item) => item.parentID === session.id);
    const childMessages = new Map();
    for (const child of children)
      childMessages.set(child.id, await request(`/session/${child.id}/message`));
    return {
      session,
      maxChildren: observed,
      children,
      childMessages,
      parentMessages: await request(`/session/${session.id}/message`),
      permissions: await request("/permission"),
    };
  };

  try {
    const delegation = await runScenario("delegation", "SCENARIO:delegation");
    assert.equal(delegation.children.length, 5);
    assert.equal(delegation.children.filter((child) => child.agent === "implementer").length, 1);
    assert.equal(delegation.children.filter((child) => child.agent === "reviewer").length, 4);
    const implementer = delegation.children.find((child) => child.agent === "implementer");
    const implementerTools = toolParts(delegation.childMessages.get(implementer.id));
    assert.deepEqual(
      implementerTools.map((part) => part.tool),
      ["edit", "bash", "bash"],
    );
    assert.equal(implementerTools[0].state.status, "completed");
    assert.equal(implementerTools[1].state.status, "completed");
    assert.equal(implementerTools[2].state.status, "completed");
    assert.match(implementerTools[1].state.output, /GH_TOKEN_PRESENT/);
    assert.match(implementerTools[1].state.output, /DEEPSEEK_API_KEY_PRESENT/);
    // Implementer ticket work may use an isolated worktree under TMPDIR, and the
    // fixture removes it again so only the shared checkout is published.
    const worktrees = await execute("git", ["worktree", "list", "--porcelain"], {
      cwd: project,
      encoding: "utf8",
    });
    assert.equal(
      worktrees.stdout
        .trim()
        .split("\n")
        .filter((line) => line.startsWith("worktree ")).length,
      1,
    );
    const branches = await execute("git", ["branch", "--list", "ticket-worktree"], {
      cwd: project,
      encoding: "utf8",
    });
    assert.equal(branches.stdout.trim(), "");
    assert.equal(
      await readFile(join(project, "edit-target.txt"), "utf8"),
      "edited by implementer\n",
    );
    const reviewerRead = delegation.children.find(
      (child) => child.agent === "reviewer" && child.title.includes("review read"),
    );
    const readTools = toolParts(delegation.childMessages.get(reviewerRead.id));
    assert.deepEqual(
      readTools.map((part) => part.state.status),
      ["completed", "error", "error"],
    );
    assert.match(readTools[1].state.error, /prevents/);
    assert.match(readTools[2].state.error, /prevents/);
    assert.ok(!JSON.stringify(delegation.childMessages.get(reviewerRead.id)).includes(sentinel));
    const reviewerEdit = delegation.children.find(
      (child) => child.agent === "reviewer" && child.title.includes("review edit"),
    );
    const editTools = toolParts(delegation.childMessages.get(reviewerEdit.id));
    assert.equal(editTools[0].state.status, "error");
    assert.match(editTools[0].state.error, /unavailable tool|invalid/i);
    const reviewerBash = delegation.children.find(
      (child) => child.agent === "reviewer" && child.title.includes("review bash"),
    );
    assert.match(
      toolParts(delegation.childMessages.get(reviewerBash.id))[0].state.error,
      /unavailable tool|invalid/i,
    );
    const reviewerTask = delegation.children.find(
      (child) => child.agent === "reviewer" && child.title.includes("review nested"),
    );
    assert.match(
      toolParts(delegation.childMessages.get(reviewerTask.id))[0].state.error,
      /unavailable tool|invalid/i,
    );
    assert.equal(
      (await request("/session")).filter((item) => item.parentID === reviewerTask.id).length,
      0,
      "reviewer must not create a nested session",
    );
    assert.equal(telemetry.childTools.implementer.includes("task"), false);
    assert.deepEqual(telemetry.childTools.reviewer, ["glob", "grep", "read"]);
    assert.deepEqual(
      toolParts(delegation.parentMessages).map((part) => part.state.status),
      ["completed", "completed", "completed", "completed", "completed"],
    );
    assert.deepEqual(delegation.permissions, []);
    assert.equal(telemetry.permissionAsks.length, 0);

    const deny = await runScenario("deny", "SCENARIO:deny");
    assert.equal(deny.children.length, 1);
    assert.equal(deny.children[0].agent, "implementer");
    const parentStatuses = toolParts(deny.parentMessages).map((part) => part.state.status);
    assert.deepEqual(parentStatuses, ["completed", "error", "error"]);
    for (const part of toolParts(deny.parentMessages).filter(
      (item) => item.state.status === "error",
    ))
      assert.match(part.state.error, /prevents/);
    assert.deepEqual(deny.permissions, []);

    const parallel = await runScenario("parallel", "SCENARIO:parallel");
    assert.equal(parallel.children.length, 3);
    assert.equal(
      parallel.children.every((child) => child.agent === "implementer"),
      true,
    );
    assert.ok(parallel.maxChildren >= 3, "the pinned runtime has no hard limit of two subagents");
    assert.deepEqual(parallel.permissions, []);
    assert.equal(telemetry.permissionAsks.length, 0);

    // The safe summary must recover delegation facts from the real file log.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const log = await readFile(join(env.XDG_DATA_HOME, "opencode/log/opencode.log"), "utf8");
    const summary = summarizeRuntimeLog(log);
    assert.ok(summary.sessions >= 9, "expected root and child sessions in the runtime log");
    assert.ok(summary.subagentSessions >= 9);
    assert.ok(summary.taskAllowed >= 3, "task allows must be observable");
    assert.ok(summary.taskDenied >= 2, "denied task types must be observable");
    assert.ok(summary.starts >= 9);
    assert.ok(summary.maxConcurrentSubagents >= 3);
    assert.equal(summary.concurrencyExceeded, "yes");
    const formatted = formatRuntimeLogSummary(summary);
    assert.match(formatted, /subagent_types=implementer:\d+,reviewer:\d+,other:0/);
    assert.match(formatted, /task_allowed=\d+/);
    assert.match(formatted, /tool_permissions=[^ ]*task:\d+/);
    assert.match(formatted, /tool_duration=unknown/);
    assert.match(formatted, /tool_name=unknown/);
    assert.match(formatted, /concurrency_enforced=no/);
    assert.match(formatted, /concurrency_exceeded=yes/);
    for (const unsafe of [sentinel, "IMPLEMENTER:", "REVIEWER-", project]) {
      assert.ok(!formatted.includes(unsafe), `safe summary must not contain ${unsafe}`);
    }
    console.log(
      "PASS: subagent delegation (implementer/reviewer split, denials, no pending permissions, log summary)",
    );
  } finally {
    controller.abort();
    try {
      await bounded(readerLoop, "delegation event stream shutdown", 5000);
    } catch {}
    try {
      process.kill(-runtimeProcess.pid, "SIGTERM");
    } catch {}
    try {
      await exited;
    } catch {}
    llm.closeAllConnections();
    await new Promise((resolve) => llm.close(resolve));
  }
}

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
  if (scenario === "allowed-skill" || scenario === "denied-skill")
    await skillFixture(project, runtime);
  let target = join(outside, "fixture.txt");
  if (scenario === "allowed-temp" || scenario === "write-temp")
    target = join(env.TMPDIR, "fixture.txt");
  if (scenario === "secret-read") target = join(project, ".env");
  if (scenario === "example-read") target = join(project, ".env.example");
  await writeFile(target, `${sentinel}\n`);
  const marker = join(outside, "shell-ran");
  const toolName =
    scenario === "allowed-skill" || scenario === "denied-skill"
      ? "skill"
      : scenario === "blocked-task"
        ? "task"
        : scenario === "write-temp"
          ? "write"
          : scenario === "external-shell"
            ? "bash"
            : "read";
  const input =
    toolName === "skill"
      ? { name: scenario === "allowed-skill" ? "to-spec" : "customize-opencode" }
      : toolName === "write"
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
    // Every scenario replaces the server on the same port. Do not carry pooled
    // keep-alive sockets across those process lifetimes (ECONNRESET on Linux).
    const headers = {
      "x-opencode-directory": project,
      "content-type": "application/json",
      connection: "close",
    };
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
    const denied = [
      "denied-external",
      "secret-read",
      "external-shell",
      "blocked-task",
      "denied-skill",
    ].includes(scenario);
    assert.equal(tools[0].state.status, denied ? "error" : "completed");
    if (denied) {
      assert.match(
        tools[0].state.error,
        scenario === "blocked-task" || scenario === "denied-skill"
          ? /denied|invalid|not found|prevents/i
          : /specified a rule which prevents/,
      );
      assert.ok(!JSON.stringify(messages).includes(sentinel));
    } else if (toolName === "read") assert.ok(tools[0].state.output.includes(sentinel));
    if (scenario === "allowed-skill")
      assert.match(tools[0].state.output, /<skill_content name="to-spec">/);
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
  await skillFixture(project, directory, false);
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
  await probeSkills(binary);
  await probeDelegation(binary);
  for (const scenario of [
    "baseline-ask",
    "denied-external",
    "allowed-temp",
    "secret-read",
    "example-read",
    "write-temp",
    "external-shell",
    "blocked-task",
    "allowed-skill",
    "denied-skill",
  ])
    await probe(binary, scenario);
  await probeAdapter(archivePath);
  await rm(root, { recursive: true, force: true });
} catch (error) {
  console.error(`OpenCode regression failed; isolated fixture retained at ${root}`);
  throw error;
}

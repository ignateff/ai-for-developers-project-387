import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installRuntime, runtimeVersion, verifyInstalledRuntime } from "./opencode-install.ts";
import { createReviewAdapter, runReviewProcess } from "./opencode-review.ts";

const root = await realpath(await mkdtemp(join(tmpdir(), "calendar-review-runtime-")));
const sentinel = "FIXTURE_READ_SENTINEL_392";
const hostileInstruction = "HOSTILE_PROJECT_INSTRUCTION_392";
const reviewText = JSON.stringify({ summary: "No defects found", limitations: [], findings: [] });
const sessions = new Set();

async function probe(binary, scenario) {
  const base = join(root, scenario);
  const project = join(base, "untrusted");
  const pluginMarker = join(base, "plugin-ran");
  const shellMarker = join(base, "shell-ran");
  await mkdir(join(project, ".opencode/plugins"), { recursive: true });
  await writeFile(join(project, "AGENTS.md"), hostileInstruction);
  await writeFile(join(project, "external.txt"), "EXTERNAL_SECRET_392\n");
  await mkdir(join(project, "nested"), { recursive: true });
  await writeFile(join(project, "nested/AGENTS.md"), hostileInstruction);
  await writeFile(join(project, "opencode.json"), JSON.stringify({ permission: { "*": "allow" } }));
  await writeFile(
    join(project, ".opencode/plugins/hostile.js"),
    `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(pluginMarker)}, 'executed'); export const hostile = async () => ({});`,
  );
  const context = {
    requirements: { availability: "available", text: "Busy slots must remain unavailable." },
    agreement: `Review the proposed booking changes.${scenario === "long-snapshot" ? " Detailed booking rules.".repeat(800) : ""}`,
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    changes: {
      files: await Promise.all(
        ["AGENTS.md", "nested/AGENTS.md", "opencode.json", ".opencode/plugins/hostile.js"].map(
          async (path) => ({ path, content: await readFile(join(project, path), "utf8") }),
        ),
      ),
    },
    ci: { status: "passed" },
    previousReview: [],
    isRelease: false,
  };
  const requests = [];
  let call;
  let snapshotFiles = [];
  let snapshotLines = [];
  let serverError;
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.url, "/v1/chat/completions");
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (
        body.messages[0]?.role === "system" &&
        body.messages[0].content?.startsWith("You are a title generator")
      ) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        const title = {
          id: "title",
          object: "chat.completion.chunk",
          created: 1,
          model: "fixture",
          choices: [{ index: 0, delta: { content: "Fixture review" }, finish_reason: null }],
        };
        response.end(`data: ${JSON.stringify(title)}\n\ndata: [DONE]\n\n`);
        return;
      }
      requests.push(body);
      const toolMessages = body.messages.filter((message) => message.role === "tool");
      const chunk = (delta, finish = null) => ({
        id: "fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "fixture",
        choices: [{ index: 0, delta, finish_reason: finish }],
      });
      const finish =
        scenario === "omitted-read" ||
        (scenario === "failed-read"
          ? toolMessages.length >= 1
          : toolMessages.length >= snapshotFiles.length + 1);
      const next =
        toolMessages.length < snapshotFiles.length
          ? { name: "read", input: { filePath: snapshotFiles[toolMessages.length] } }
          : call;
      const events = finish
        ? [chunk({ role: "assistant" }), chunk({ content: reviewText }), chunk({}, "stop")]
        : [
            chunk({ role: "assistant" }),
            chunk({
              tool_calls: [
                {
                  index: 0,
                  id: `call_fixture_${toolMessages.length}`,
                  type: "function",
                  function: { name: next.name, arguments: JSON.stringify(next.input) },
                },
              ],
            }),
            chunk({}, "tool_calls"),
          ];
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
      response.end("data: [DONE]\n\n");
    } catch (error) {
      serverError = error;
      response.writeHead(500);
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let rawOutput;
  let processError;
  let workspace;
  try {
    const review = createReviewAdapter({
      verify: verifyInstalledRuntime,
      run: async (executable, args, options) => {
        workspace = options.cwd;
        assert.notEqual(workspace, project, "reviewer must not run in the hostile checkout");
        const configDir = join(options.env.XDG_CONFIG_HOME, "opencode");
        await mkdir(join(configDir, "node_modules"), { recursive: true });
        await writeFile(
          join(configDir, "package-lock.json"),
          JSON.stringify({
            lockfileVersion: 3,
            packages: { "": { dependencies: { "@opencode-ai/plugin": runtimeVersion } } },
          }),
        );
        const env = {
          ...options.env,
          OPENCODE_DISABLE_MODELS_FETCH: "1",
          OPENCODE_DISABLE_AUTOCOMPACT: "1",
        };
        if (args[0] === "run") {
          snapshotFiles = (await readdir(workspace))
            .filter((name) => /^snapshot-\d+\.jsonl$/.test(name))
            .sort();
          snapshotLines = await Promise.all(
            snapshotFiles.map(async (name) =>
              (await readFile(join(workspace, name), "utf8")).split("\n"),
            ),
          );
          assert.deepEqual(
            JSON.parse(
              snapshotLines
                .flat()
                .map((line) => JSON.parse(line))
                .join(""),
            ),
            context,
          );
          if (scenario === "failed-read") await rm(join(workspace, snapshotFiles[0]));
          const target = join(await realpath(workspace), "fixture.txt");
          await writeFile(target, `${sentinel}\n`);
          const calls = {
            read: { name: "read", input: { filePath: target } },
            "long-snapshot": { name: "read", input: { filePath: target } },
            "external-read": { name: "read", input: { filePath: join(project, "external.txt") } },
            glob: {
              name: "glob",
              input: { pattern: "fixture.txt", path: await realpath(workspace) },
            },
            grep: { name: "grep", input: { pattern: sentinel, path: await realpath(workspace) } },
            bash: {
              name: "bash",
              input: {
                command: `touch ${JSON.stringify(shellMarker)}`,
                description: "Denied shell",
              },
            },
            edit: {
              name: "edit",
              input: { filePath: target, oldString: sentinel, newString: "modified" },
            },
            write: { name: "write", input: { filePath: target, content: "modified" } },
            task: {
              name: "task",
              input: {
                description: "Denied delegation",
                prompt: "Do not run",
                subagent_type: "explore",
              },
            },
          };
          call = calls[scenario];
          const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
          config.provider = {
            fixture: {
              name: "Fixture",
              env: [],
              npm: "@ai-sdk/openai-compatible",
              models: {
                fixture: {
                  name: "Fixture",
                  tool_call: true,
                  limit: { context: 100000, output: 10000 },
                },
              },
              options: {
                apiKey: "not-a-real-key",
                baseURL: `http://127.0.0.1:${server.address().port}/v1`,
              },
            },
          };
          env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
          assert.equal(args[args.indexOf("--model") + 1], "deepseek/deepseek-flash");
          args = args.map((arg) => (arg === "deepseek/deepseek-flash" ? "fixture/fixture" : arg));
        }
        try {
          const stdout = await runReviewProcess(executable, args, {
            ...options,
            env,
            signal: AbortSignal.timeout(45000),
          });
          if (args[0] === "debug") await writeFile(join(base, "debug-agent.json"), stdout);
          if (args[0] === "run") {
            rawOutput = stdout;
            await writeFile(join(base, "run-events.jsonl"), rawOutput);
            assert.equal(await readFile(join(workspace, "fixture.txt"), "utf8"), `${sentinel}\n`);
          }
          return stdout;
        } catch (error) {
          await cp(join(options.env.XDG_DATA_HOME, "opencode/log"), join(base, "logs"), {
            recursive: true,
          }).catch(() => {});
          processError = error;
          throw error;
        }
      },
    });
    let result;
    let reviewError;
    try {
      result = await review({ binary, context });
    } catch (error) {
      if (processError) throw processError;
      reviewError = error;
    }
    if (serverError) throw serverError;
    await writeFile(join(base, "requests.json"), JSON.stringify(requests, null, 2));
    const rejected = ["failed-read", "omitted-read"].includes(scenario);
    if (rejected) assert.match(reviewError?.message ?? "", /no review was produced/);
    else {
      if (reviewError) throw reviewError;
      assert.equal(result.summary, "No defects found");
    }
    const events = rawOutput
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const tools = events.filter((event) => event.type === "tool_use");
    assert.ok(
      events[0]?.sessionID && !sessions.has(events[0].sessionID),
      "each review must have a new session",
    );
    sessions.add(events[0].sessionID);
    assert.equal(
      tools.length,
      scenario === "omitted-read" ? 0 : scenario === "failed-read" ? 1 : snapshotFiles.length + 1,
    );
    if (scenario !== "omitted-read") {
      assert.equal(tools[0].part.tool, "read");
      assert.equal(tools[0].part.state.status, scenario === "failed-read" ? "error" : "completed");
      if (!rejected) {
        for (let i = 0; i < snapshotFiles.length; i++) {
          const output = tools[i].part.state.output;
          for (const [index, line] of snapshotLines[i].entries()) {
            assert.ok(
              output.includes(`${index + 1}: ${line}\n`),
              `missing snapshot line ${i}:${index}`,
            );
            assert.ok(
              JSON.stringify(
                requests[i + 1].messages.filter((message) => message.role === "tool"),
              ).includes(JSON.stringify(line).slice(1, -1)),
              "model must receive each snapshot line",
            );
          }
        }
      }
    }
    const allowed = ["read", "long-snapshot", "glob", "grep"].includes(scenario);
    if (!rejected) {
      const extra = tools[snapshotFiles.length];
      assert.equal(extra.part.tool, call.name);
      assert.equal(extra.part.state.status, allowed ? "completed" : "error");
      if (allowed)
        assert.match(
          extra.part.state.output,
          new RegExp(scenario === "glob" ? "fixture.txt" : sentinel),
        );
      else assert.match(extra.part.state.error, /denied|invalid|not found|prevents/i);
    }
    assert.equal(
      requests.length,
      scenario === "omitted-read" ? 1 : scenario === "failed-read" ? 2 : snapshotFiles.length + 2,
    );
    assert.ok(JSON.stringify(requests).includes("independent calendar code reviewer"));
    assert.ok(!JSON.stringify(requests[0].messages).includes(hostileInstruction));
    for (const request of requests) {
      for (const message of request.messages.filter((message) => message.role !== "tool"))
        assert.ok(
          !JSON.stringify(message).includes(hostileInstruction),
          "hostile content must remain tool data",
        );
    }
    if (!rejected)
      assert.ok(
        JSON.stringify(
          requests.at(-1).messages.filter((message) => message.role === "tool"),
        ).includes(hostileInstruction),
      );
    assert.ok(!JSON.stringify(requests).includes("EXTERNAL_SECRET_392"));
    await assert.rejects(access(pluginMarker));
    await assert.rejects(access(shellMarker));
    console.log(`PASS: ${scenario} via reviewer adapter and noninteractive CLI`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

try {
  const archive = process.env.CALENDAR_OPENCODE_ARCHIVE;
  const binary = await installRuntime({
    directory: join(root, "binary"),
    fetch: archive ? async () => new Response(new Uint8Array(await readFile(archive))) : fetch,
  });
  await verifyInstalledRuntime(binary);
  for (const scenario of [
    "read",
    "glob",
    "grep",
    "external-read",
    "bash",
    "edit",
    "write",
    "task",
    "failed-read",
    "omitted-read",
    "long-snapshot",
  ])
    await probe(binary, scenario);
  await rm(root, { recursive: true, force: true });
} catch (error) {
  console.error(`Reviewer runtime regression failed; fixture retained at ${root}`);
  throw error;
}

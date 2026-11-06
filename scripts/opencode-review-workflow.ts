import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { installRuntime } from "./opencode-install.ts";
import { reviewSnapshot } from "./opencode-review.ts";

export async function reviewWorkflow(mode: string, env: NodeJS.ProcessEnv) {
  const root = resolve(
    env.RUNNER_TEMP ?? "",
    `opencode-review-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`,
  );
  if (
    !env.RUNNER_TEMP ||
    !/^\d+$/.test(env.GITHUB_RUN_ID ?? "") ||
    !/^\d+$/.test(env.GITHUB_RUN_ATTEMPT ?? "")
  )
    throw new Error();
  if (mode === "prepare") {
    if (env.DEEPSEEK_API_KEY) throw new Error();
    await mkdir(root, { mode: 0o700 });
    const binary = await installRuntime({ directory: join(root, "runtime") });
    await writeFile(join(root, "binary"), binary, { flag: "wx", mode: 0o600 });
    return;
  }
  if (mode !== "run" || !env.DEEPSEEK_API_KEY) throw new Error();
  const repository = env.GITHUB_REPOSITORY ?? "";
  const number = env.OPENCODE_PR_NUMBER ?? "";
  const sha = env.OPENCODE_HEAD_SHA ?? "";
  const token = env.GH_TOKEN ?? "";
  if (
    !/^[\w-]+\/[\w.-]+$/.test(repository) ||
    !/^[1-9]\d*$/.test(number) ||
    !/^[a-f\d]{40}$/i.test(sha) ||
    !token ||
    /[\r\n]/.test(token)
  )
    throw new Error();
  const get = async (path: string) => {
    const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error();
    return response.json();
  };
  const pr = await get(`pulls/${number}`);
  if (
    pr.number !== Number(number) ||
    pr.state !== "open" ||
    pr.draft !== false ||
    pr.head?.sha !== sha ||
    pr.head?.repo?.id !== pr.base?.repo?.id ||
    pr.base?.repo?.full_name?.toLowerCase() !== repository.toLowerCase() ||
    pr.head?.repo?.full_name?.toLowerCase() !== repository.toLowerCase() ||
    !/^[a-f\d]{40}$/i.test(pr.base?.sha ?? "")
  )
    throw new Error();
  const changes: unknown[] = [];
  for (let page = 1; page <= 30; page++) {
    const files = await get(`pulls/${number}/files?per_page=100&page=${page}`);
    if (!Array.isArray(files)) throw new Error();
    changes.push(...files);
    if (files.length < 100) break;
    if (page === 30) throw new Error();
  }
  const binary = await readFile(join(root, "binary"), "utf8");
  const result = await reviewSnapshot({
    binary,
    apiKey: env.DEEPSEEK_API_KEY,
    context: {
      requirements: {
        availability: "unavailable",
        reason: "Requirements and agreement were not collected by this budget-only workflow",
      },
      agreement: null,
      baseSha: pr.base.sha,
      headSha: sha,
      changes: JSON.parse(JSON.stringify(changes)),
      ci: { availability: "unavailable" },
      previousReview: { availability: "unavailable" },
      isRelease: false,
    },
  });
  await writeFile(join(root, "review.json"), JSON.stringify(result), { flag: "wx", mode: 0o600 });
  console.log("OpenCode review: result saved for publication");
}

if (import.meta.main) {
  try {
    await reviewWorkflow(process.argv[2], process.env);
  } catch {
    console.error("OpenCode review workflow: infra or review failed; no success is claimed");
    process.exitCode = 1;
  }
}

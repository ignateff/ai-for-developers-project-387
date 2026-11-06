import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { installRuntime } from "./opencode-install.ts";
import { reviewSnapshot } from "./opencode-review.ts";

export async function reviewWorkflow(
  mode: string,
  env: NodeJS.ProcessEnv,
  deps: { fetch?: typeof fetch; review?: typeof reviewSnapshot } = {},
) {
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
    const response = await (deps.fetch ?? fetch)(
      `https://api.github.com/repos/${repository}/${path}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!response.ok) throw new Error();
    return response.json();
  };
  const pr = await get(`pulls/${number}`);
  if (
    pr.number !== Number(number) ||
    pr.state !== "open" ||
    pr.draft !== false ||
    pr.head?.sha !== sha ||
    !Number.isSafeInteger(pr.base?.repo?.id) ||
    pr.base.repo.id <= 0 ||
    pr.head?.repo?.id !== pr.base?.repo?.id ||
    pr.base?.repo?.full_name?.toLowerCase() !== repository.toLowerCase() ||
    pr.head?.repo?.full_name?.toLowerCase() !== repository.toLowerCase() ||
    !/^[a-f\d]{40}$/i.test(pr.base?.sha ?? "")
  )
    throw new Error();
  const files: any[] = [];
  for (let page = 1; page <= 30; page++) {
    const pageFiles = await get(`pulls/${number}/files?per_page=100&page=${page}`);
    if (!Array.isArray(pageFiles)) throw new Error();
    files.push(...pageFiles);
    if (pageFiles.length < 100) break;
    if (page === 30) throw new Error();
  }
  if (
    !Number.isSafeInteger(pr.changed_files) ||
    pr.changed_files < 1 ||
    files.length !== pr.changed_files
  )
    throw new Error();
  let sourceBytes = 0;
  const source = async (name: unknown, ref: string) => {
    if (
      typeof name !== "string" ||
      !name ||
      name.length > 1000 ||
      /[\x00-\x1f\x7f]/.test(name) ||
      name.split("/").some((part) => !part || part === "." || part === "..")
    )
      throw new Error();
    const path = name.split("/").map(encodeURIComponent).join("/");
    const data = await get(`contents/${path}?ref=${ref}`);
    if (
      data?.type !== "file" ||
      data.encoding !== "base64" ||
      typeof data.content !== "string" ||
      !Number.isSafeInteger(data.size) ||
      data.size < 0 ||
      data.size > 1024 * 1024
    )
      throw new Error();
    const encoded = data.content.replace(/\n/g, "");
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
      throw new Error();
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length !== data.size) throw new Error();
    sourceBytes += bytes.length;
    if (sourceBytes > 2 * 1024 * 1024) throw new Error();
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  };
  const changes = [];
  for (const file of files) {
    if (
      !file ||
      typeof file !== "object" ||
      !["added", "removed", "modified", "renamed"].includes(file.status)
    )
      throw new Error();
    const baseName = file.status === "renamed" ? file.previous_filename : file.filename;
    const baseSource = file.status === "added" ? null : await source(baseName, pr.base.sha);
    const headSource = file.status === "removed" ? null : await source(file.filename, sha);
    changes.push({
      filename: file.filename,
      previousFilename: file.previous_filename ?? null,
      status: file.status,
      patch: typeof file.patch === "string" ? file.patch : null,
      baseSource,
      headSource,
    });
  }
  const current = await get(`pulls/${number}`);
  if (current?.head?.sha !== sha || current?.base?.sha !== pr.base.sha) throw new Error();
  const binary = await readFile(join(root, "binary"), "utf8");
  const result = await (deps.review ?? reviewSnapshot)({
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
      changes,
      ci: { availability: "unavailable" },
      previousReview: { availability: "unavailable" },
      isRelease: false,
    },
  });
  result.limitations.push(
    "Only changed files were collected at pinned base/head; the full repository, CI, agreement and previous review context were not collected.",
  );
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

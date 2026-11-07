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
  const get = async (path: string, repo = repository) => {
    const response = await (deps.fetch ?? fetch)(`https://api.github.com/repos/${repo}/${path}`, {
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
  // Optional context is untrusted evidence, never a reason to broaden API access.
  const limitations = [
    "Only changed files were collected at pinned base/head; the full repository was not collected.",
    "Trusted base documentation and links nested in referenced materials were not collected.",
  ];
  const optional = async (path: string, repo = repository) => {
    try {
      return await get(path, repo);
    } catch {
      return null;
    }
  };
  let truncated = false;
  const text = (value: unknown) => {
    if (typeof value !== "string") return "";
    if (value.length > 30000) truncated = true;
    return value.slice(0, 30000);
  };
  const body = text(pr.body);
  const refs = new Map<string, { repo: string; issue: string; comment?: string }>();
  const full =
    /https:\/\/github\.com\/ignateff\/ai-for-developers-project-(387|386)\/issues\/(\d+)(?:#issuecomment-(\d+))?/gi;
  for (const match of body.matchAll(full)) {
    const ref = {
      repo: `ignateff/ai-for-developers-project-${match[1]}`,
      issue: match[2],
      comment: match[3],
    };
    refs.set(`${ref.repo}/${ref.issue}/${ref.comment ?? ""}`, ref);
  }
  const withoutUrls = body.replace(/https?:\/\/[^\s)\]>]+/gi, " ");
  for (const match of withoutUrls.matchAll(/(?:^|[^\w/])#([1-9]\d*)\b/g)) {
    const ref = { repo: "ignateff/ai-for-developers-project-387", issue: match[1] };
    refs.set(`${ref.repo}/${ref.issue}/`, ref);
  }
  if (refs.size > 12) limitations.push("Linked GitHub references exceeded the collection limit.");
  if (
    /https?:\/\/(?!github\.com\/ignateff\/ai-for-developers-project-(?:387|386)\/issues\/)/i.test(
      body,
    )
  )
    limitations.push("External or unsupported links were not loaded.");
  const materials = [];
  const agreements = [];
  for (const ref of [...refs.values()].slice(0, 12)) {
    const issue = await optional(`issues/${ref.issue}`, ref.repo);
    if (!issue || typeof issue !== "object" || typeof issue.body !== "string") {
      limitations.push(`Linked issue ${ref.repo}#${ref.issue} was unavailable.`);
    } else
      materials.push({
        source: `${ref.repo}#${ref.issue}`,
        title: text(issue.title),
        body: text(issue.body),
      });
    if (ref.comment) {
      const comment = await optional(`issues/comments/${ref.comment}`, ref.repo);
      if (!comment || typeof comment.body !== "string") {
        limitations.push(`Linked comment ${ref.repo}#issuecomment-${ref.comment} was unavailable.`);
        continue;
      }
      const login = comment.user?.login;
      const validLogin =
        typeof login === "string" && /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(login);
      const permission =
        validLogin && comment.user?.type === "User"
          ? await optional(
              `collaborators/${encodeURIComponent(login)}/permission`,
              "ignateff/ai-for-developers-project-387",
            )
          : null;
      const belongs =
        comment.issue_url === `https://api.github.com/repos/${ref.repo}/issues/${ref.issue}`;
      // Permission and explicit wording are evidence for the reviewer, not a semantic approval verdict.
      agreements.push({
        source: `${ref.repo}#${ref.issue}#issuecomment-${ref.comment}`,
        author: validLogin ? login : null,
        text: text(comment.body),
        authorPermission: permission?.permission ?? null,
        status: "unconfirmed",
        reason:
          belongs && ["admin", "maintain", "write"].includes(permission?.permission)
            ? "Human authority verified; explicit approval of requirements must be assessed from the text."
            : "Comment identity or current human authority could not be verified.",
      });
    }
  }
  limitations.push(
    "Agreement is unconfirmed unless explicit human approval of requirements is established from the linked evidence.",
  );
  const checks = await optional(`commits/${sha}/check-runs?per_page=100`);
  const statuses = await optional(`commits/${sha}/status?per_page=100`);
  const reviews = await optional(`pulls/${number}/reviews?per_page=100`);
  const reviewComments = await optional(`pulls/${number}/comments?per_page=100`);
  const issueComments = await optional(`issues/${number}/comments?per_page=100`);
  if (!Array.isArray(checks?.check_runs) || !Array.isArray(statuses?.statuses))
    limitations.push("CI context is incomplete or unavailable; pending checks are not successful.");
  if (!Array.isArray(reviews) || !Array.isArray(reviewComments) || !Array.isArray(issueComments))
    limitations.push("Previous review or discussion context is incomplete or unavailable.");
  if (
    [reviews, reviewComments, issueComments, checks?.check_runs, statuses?.statuses].some(
      (x) => Array.isArray(x) && x.length >= 100,
    )
  )
    limitations.push("CI or previous review context may be truncated at 100 items per endpoint.");
  const comments = (value: unknown) =>
    Array.isArray(value)
      ? value.slice(0, 100).map((c) => ({
          author: text(c?.user?.login),
          body: text(c?.body),
          path: text(c?.path),
          state: text(c?.state),
          url: text(c?.html_url),
        }))
      : null;
  const isRelease =
    pr.user?.login === "calendar-release-ignateff-bot[bot]" &&
    pr.user?.id === 351107404 &&
    pr.user?.type === "Bot";
  const context = {
    requirements: materials.length
      ? {
          availability: "available" as const,
          text: JSON.stringify({ description: body, materials }),
        }
      : {
          availability: "unavailable" as const,
          reason: "No linked requirements could be loaded; PR description: " + body,
        },
    agreement: { sources: agreements, limitations },
    baseSha: pr.base.sha,
    headSha: sha,
    changes,
    ci: {
      checks: Array.isArray(checks?.check_runs)
        ? checks.check_runs.slice(0, 100).map((c: any) => ({
            name: text(c?.name),
            status: text(c?.status),
            conclusion: text(c?.conclusion),
            url: text(c?.html_url),
          }))
        : null,
      status: text(statuses?.state),
      statuses: Array.isArray(statuses?.statuses)
        ? statuses.statuses.slice(0, 100).map((s: any) => ({
            context: text(s?.context),
            state: text(s?.state),
            url: text(s?.target_url),
          }))
        : null,
    },
    previousReview: {
      reviews: comments(reviews),
      reviewComments: comments(reviewComments),
      issueComments: comments(issueComments),
    },
    isRelease,
  };
  if (truncated) limitations.push("Some context text was truncated at 30000 characters.");
  const current = await get(`pulls/${number}`);
  if (current?.head?.sha !== sha || current?.base?.sha !== pr.base.sha) throw new Error();
  const binary = await readFile(join(root, "binary"), "utf8");
  const result = await (deps.review ?? reviewSnapshot)({
    binary,
    apiKey: env.DEEPSEEK_API_KEY,
    context: JSON.parse(
      JSON.stringify(context)
        .split(JSON.stringify(token).slice(1, -1))
        .join("[REDACTED]")
        .split(JSON.stringify(env.DEEPSEEK_API_KEY).slice(1, -1))
        .join("[REDACTED]"),
    ),
  });
  result.limitations.push(...limitations);
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

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  collectRepositoryContext,
  safeRepositoryPath,
  type TreeEntry,
} from "./opencode-review-repository.ts";

export type GhAwReviewMeta = {
  schema: "gh-aw-review-meta/v1";
  number: number;
  baseSha: string;
  headSha: string;
  runId: string;
  runAttempt: string;
  artifact: string;
  authorId: number;
  limitations: string[];
  repositoryAvailable: boolean;
  isRelease: boolean;
};

export type GhAwReviewContext = {
  snapshot: Record<string, any>;
  meta: GhAwReviewMeta;
};

export type GhAwReviewContextOptions = {
  fetch: typeof fetch;
  repository: string;
  token: string;
  number: number;
  expectedHeadSha: string;
  runId: string;
  runAttempt: string;
  outputDirectory: string;
  progress?: (stage: string) => void;
};

const object = (value: unknown): Record<string, any> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : {};

const fullSha = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f\d]{40}$/i.test(value);

const positive = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;

const writeFileSafely = async (path: string, content: string, mode = 0o600) => {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content, { mode });
};

/**
 * Build the bounded review snapshot from the trusted default branch.
 * PR content is only read through the GitHub API and written as data; no PR
 * code is checked out, imported or executed.
 */
export async function collectGhAwReviewContext(
  options: GhAwReviewContextOptions,
): Promise<GhAwReviewContext> {
  const { repository, token, number, expectedHeadSha } = options;
  if (
    !/^[\w-]+\/[\w.-]+$/.test(repository) ||
    !token ||
    /[\r\n]/.test(token) ||
    !positive(number) ||
    !fullSha(expectedHeadSha) ||
    !positive(Number(options.runId)) ||
    !positive(Number(options.runAttempt)) ||
    !options.outputDirectory
  )
    throw new Error("Invalid review context input");
  const output = resolve(options.outputDirectory);
  if (output === resolve("/")) throw new Error("Unsafe review context output directory");

  const request = async (path: string, repo = repository) => {
    const response = await options.fetch(`https://api.github.com/repos/${repo}/${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error("GitHub request failed");
    return response.json();
  };
  const optional = async (path: string, repo = repository) => {
    try {
      return await request(path, repo);
    } catch {
      return null;
    }
  };

  options.progress?.("PR context collection started");
  const pr = object(await request(`pulls/${number}`));
  const base = object(pr.base);
  const head = object(pr.head);
  const baseRepo = object(base.repo);
  const headRepo = object(head.repo);
  if (
    pr.number !== number ||
    pr.state !== "open" ||
    pr.draft !== false ||
    head.sha !== expectedHeadSha ||
    !positive(baseRepo.id) ||
    baseRepo.id !== headRepo.id ||
    baseRepo.full_name?.toLowerCase() !== repository.toLowerCase() ||
    headRepo.full_name?.toLowerCase() !== repository.toLowerCase() ||
    !fullSha(base.sha)
  )
    throw new Error("PR provenance, draft state or pinned head changed");

  const files: any[] = [];
  for (let page = 1; page <= 30; page++) {
    const pageFiles = await request(`pulls/${number}/files?per_page=100&page=${page}`);
    if (!Array.isArray(pageFiles)) throw new Error("Invalid changed files response");
    files.push(...pageFiles);
    if (pageFiles.length < 100) break;
    if (page === 30) throw new Error("Changed files pagination limit reached");
  }
  if (!positive(pr.changed_files) || files.length !== pr.changed_files)
    throw new Error("Changed file list is incomplete");

  options.progress?.("changed file collection started");
  const readContent = async (
    name: unknown,
    ref: string,
    repo = repository,
    maxBytes = 1024 * 1024,
    allowBinary = false,
  ) => {
    if (!safeRepositoryPath(name)) throw new Error("Unsafe repository path");
    const path = name.split("/").map(encodeURIComponent).join("/");
    const data = object(await request(`contents/${path}?ref=${ref}`, repo));
    if (
      data.type !== "file" ||
      data.encoding !== "base64" ||
      typeof data.content !== "string" ||
      !Number.isSafeInteger(data.size) ||
      data.size < 0 ||
      data.size > maxBytes
    )
      throw new Error("Invalid file response");
    const encoded = data.content.replace(/\n/g, "");
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
      throw new Error("Invalid base64");
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length !== data.size) throw new Error("File size mismatch");
    try {
      const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      if (decoded.includes("\0")) throw new TypeError("Binary content");
      return { bytes, decoded, binary: false };
    } catch (error) {
      if (!allowBinary || !(error instanceof TypeError)) throw error;
      return { bytes, decoded: "", binary: true };
    }
  };

  let sourceBytes = 0;
  const limitations: string[] = [];
  const essentialLimitations = new Set<string>();
  const essential = (...items: string[]) => {
    for (const item of items) {
      if (!essentialLimitations.has(item)) essentialLimitations.add(item);
      if (!limitations.includes(item)) limitations.push(item);
    }
  };
  const binaryLimitations = new Set<string>();
  const source = async (name: unknown, ref: string, repo = repository) => {
    const { bytes, decoded, binary } = await readContent(name, ref, repo, 1024 * 1024, true);
    if (sourceBytes + bytes.length > 2 * 1024 * 1024)
      throw new Error("Changed source exceeds the review context limit");
    sourceBytes += bytes.length;
    if (binary) {
      binaryLimitations.add(`Двоичное содержимое не проверялось: ${String(name)}`);
      return null;
    }
    return decoded;
  };

  const changes: any[] = [];
  for (const file of files) {
    if (
      !file ||
      typeof file !== "object" ||
      !["added", "removed", "modified", "renamed"].includes(file.status)
    )
      throw new Error("Unsupported changed file entry");
    const baseName = file.status === "renamed" ? file.previous_filename : file.filename;
    const baseSource = file.status === "added" ? null : await source(baseName, base.sha);
    const headSource = file.status === "removed" ? null : await source(file.filename, head.sha);
    changes.push({
      filename: file.filename,
      previousFilename: file.previous_filename ?? null,
      status: file.status,
      patch: typeof file.patch === "string" ? file.patch : null,
      baseSource,
      headSource,
    });
  }
  for (const item of binaryLimitations) essential(item);

  const readTree = async (ref: string) => {
    const data = object(await request(`git/trees/${ref}?recursive=1`));
    if (!Array.isArray(data.tree) || data.truncated === true)
      throw new Error("Repository tree is unavailable or truncated");
    if (data.tree.length > 20000) throw new Error("Repository tree exceeds the cap");
    const entries = new Map<string, TreeEntry>();
    for (const entry of data.tree) {
      if (!entry || typeof entry !== "object") throw new Error("Malformed tree entry");
      if (entry.type === "tree" || entry.type === "commit") continue;
      if (
        entry.type !== "blob" ||
        !safeRepositoryPath(entry.path) ||
        !fullSha(entry.sha) ||
        !Number.isSafeInteger(entry.size) ||
        entry.size < 0 ||
        entries.has(entry.path)
      )
        throw new Error("Malformed tree entry");
      entries.set(entry.path, {
        path: entry.path,
        sha: entry.sha.toLowerCase(),
        size: entry.size,
      });
    }
    return entries;
  };

  options.progress?.("related repository context collection started");
  const repositoryContext = await collectRepositoryContext({
    baseSha: base.sha,
    headSha: head.sha,
    changes,
    tree: readTree,
    read: (path, maxBytes) => readContent(path, head.sha, repository, maxBytes),
    essential,
  });

  options.progress?.("supplementary context collection started");
  let truncated = false;
  let aggregateTruncated = false;
  let textBudget = 256 * 1024;
  const text = (value: unknown) => {
    if (typeof value !== "string") return "";
    if (value.length > 30000) truncated = true;
    const candidate = value.slice(0, 30000);
    const cost = (s: string) => Buffer.byteLength(JSON.stringify(JSON.stringify(s)));
    let low = 0;
    let high = candidate.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (cost(candidate.slice(0, middle)) <= textBudget) low = middle;
      else high = middle - 1;
    }
    if (low < candidate.length) aggregateTruncated = true;
    const result = candidate.slice(0, low);
    textBudget = Math.max(0, textBudget - cost(result));
    return result;
  };

  const body = text(pr.body);
  const refs = new Map<string, { repo: string; issue: string; comment?: string }>();
  const documentLinks = new Set<string>();
  const full =
    /https:\/\/github\.com\/ignateff\/ai-for-developers-project-(387|386)\/issues\/(\d+)(?:#issuecomment-(\d+))?/gi;
  const collectRefs = (input: string, origin = repository) => {
    for (const match of input.matchAll(/\]\((?!https?:\/\/|#)([^\s)]+\.md)(?:#[^\s)]*)?\)/gi))
      if (origin.toLowerCase() === "ignateff/ai-for-developers-project-387")
        documentLinks.add(match[1]);
      else
        essential(
          `Относительную ссылку на документ в ${origin} не удалось загрузить без закреплённого ref репозитория.`,
        );
    for (const match of input.matchAll(
      /https:\/\/github\.com\/ignateff\/ai-for-developers-project-(?:387|386)\/(?:blob|tree)\/[^\s)\]>]+/gi,
    ))
      documentLinks.add(match[0]);
    for (const match of input.matchAll(full)) {
      const ref = {
        repo: `ignateff/ai-for-developers-project-${match[1]}`,
        issue: match[2],
        comment: match[3],
      };
      refs.set(`${ref.repo}/${ref.issue}/${ref.comment ?? ""}`, ref);
    }
    const withoutUrls = input.replace(/https?:\/\/[^\s)\]>]+/gi, " ");
    for (const match of withoutUrls.matchAll(/(?:^|[^\w/])#([1-9]\d*)\b/g)) {
      const ref = { repo: "ignateff/ai-for-developers-project-387", issue: match[1] };
      refs.set(`${ref.repo}/${ref.issue}/`, ref);
    }
    if (
      /https?:\/\/(?!github\.com\/ignateff\/ai-for-developers-project-(?:387|386)\/(?:issues|blob)\/)/i.test(
        input,
      )
    )
      essential("Внешние или неподдерживаемые ссылки не загружались.");
  };
  collectRefs(body);
  const directDocuments = new Set(documentLinks);
  const directRefs = new Set(refs.keys());

  const baseDocs: { path: string; sha: string; body: string }[] = [];
  let criteria: { path: string; available: boolean; content: string | null } = {
    path: "REVIEW.md",
    available: false,
    content: null,
  };
  for (const name of ["AGENTS.md", "README.md", "REVIEW.md", "docs/agents/project-history.md"]) {
    try {
      const content = text(await source(name, base.sha));
      baseDocs.push({ path: name, sha: base.sha, body: content });
      if (name === "REVIEW.md") criteria = { path: name, available: true, content };
    } catch {
      essential(`Доверенный базовый документ ${name} недоступен.`);
    }
  }

  const materials: { source: string; title: string; body: string }[] = [];
  const agreements: Record<string, any>[] = [];
  const visited = new Set<string>();
  for (const [key, ref] of refs) {
    if (visited.size >= 12) break;
    visited.add(key);
    const issue = object(await optional(`issues/${ref.issue}`, ref.repo));
    if (!issue || typeof issue.body !== "string") {
      essential(`Связанная задача ${ref.repo}#${ref.issue} недоступна.`);
    } else {
      const issueBody = text(issue.body);
      materials.push({
        source: `${ref.repo}#${ref.issue}`,
        title: text(issue.title),
        body: issueBody,
      });
      collectRefs(issueBody, ref.repo);
    }
    if (ref.comment) {
      const comment = object(await optional(`issues/comments/${ref.comment}`, ref.repo));
      if (!comment || typeof comment.body !== "string") {
        essential(`Связанный комментарий ${ref.repo}#issuecomment-${ref.comment} недоступен.`);
        continue;
      }
      const commentLogin = object(comment.user).login;
      const validLogin =
        typeof commentLogin === "string" &&
        /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(commentLogin);
      const permission =
        validLogin && object(comment.user).type === "User"
          ? object(
              await optional(
                `collaborators/${encodeURIComponent(commentLogin)}/permission`,
                "ignateff/ai-for-developers-project-387",
              ),
            )
          : null;
      const belongs =
        comment.issue_url === `https://api.github.com/repos/${ref.repo}/issues/${ref.issue}`;
      const eligible =
        belongs &&
        validLogin &&
        object(comment.user).type === "User" &&
        ["admin", "maintain", "write"].includes(permission?.permission);
      const commentBody = text(comment.body);
      collectRefs(commentBody, ref.repo);
      agreements.push({
        source: `${ref.repo}#${ref.issue}#issuecomment-${ref.comment}`,
        author: validLogin ? commentLogin : null,
        text: commentBody,
        authorPermission: permission?.permission ?? null,
        eligible: Boolean(eligible),
        explicitlyLinkedInPr: directRefs.has(key),
        status: "unconfirmed",
        reason: !directRefs.has(key)
          ? "This evidence was not explicitly linked in the PR description."
          : eligible
            ? "Eligible human author; explicit approval of requirements must be established from the text."
            : "Comment identity or current human authority could not be verified.",
      });
    }
  }
  if (refs.size > visited.size)
    essential("Количество связанных ссылок GitHub превысило лимит сбора.");

  for (const link of [...documentLinks].slice(0, 12)) {
    const match =
      /^https:\/\/github\.com\/ignateff\/ai-for-developers-project-(387|386)\/blob\/([^/]+)\/([^?#]+)(?:[?#].*)?$/i.exec(
        link,
      );
    const relative = !link.startsWith("https://") && !link.includes(":");
    const project = match?.[1] ?? (relative ? "387" : "");
    const requestedRef = match?.[2] ?? (relative ? "PR base" : "");
    const encodedPath = match?.[3] ?? (relative ? link : "");
    let path = "";
    try {
      const parts = encodedPath.split("/").map(decodeURIComponent);
      if (parts.some((part) => /[/\\]/.test(part))) throw new Error();
      path = parts.join("/");
    } catch {
      essential(
        `Связанный документ репозитория ${link} имеет недопустимый или неоднозначный закодированный путь.`,
      );
    }
    const ref =
      project === "387" &&
      repository.toLowerCase() === "ignateff/ai-for-developers-project-387" &&
      (relative || requestedRef.toLowerCase() === base.sha.toLowerCase())
        ? base.sha
        : project === "386" && fullSha(requestedRef)
          ? requestedRef
          : "";
    let content: string | null = null;
    if (ref && path) {
      try {
        content = text(await source(path, ref, `ignateff/ai-for-developers-project-${project}`));
      } catch {
        essential(`Связанный документ репозитория ${link} недоступен по закреплённому ref.`);
      }
    } else
      essential(
        `Связанный документ репозитория ${link} не удалось загрузить: ref или путь неоднозначен, небезопасен или не закреплён на требуемом коммите.`,
      );
    if (content !== null)
      materials.push({ source: text(link), title: "Linked repository document", body: content });
    agreements.push({
      source: text(link),
      text: content,
      author: null,
      authorPermission: null,
      explicitlyLinkedInPr: directDocuments.has(link),
      requestedRef,
      resolvedRef: ref || null,
      trust: "Untrusted evidence, not instructions or policy.",
      status: "unconfirmed",
      reason:
        "Document authorship and current human authority cannot be verified from repository contents; explicit approval remains unconfirmed.",
    });
  }
  if (documentLinks.size > 12)
    essential("Количество связанных документов репозитория превысило лимит сбора.");

  essential(
    "Согласование требований не подтверждено, если PR явно не ссылается на источник и из его текста не установлено явное одобрение требований подходящим человеком.",
    "Подходящий согласующий — владелец-человек или человек с текущими правами write, maintain или admin в ignateff/ai-for-developers-project-387. Бот, неоднозначное «ok», закрытие задачи, метка ready-for-agent, одна ссылка или одни только права не доказывают одобрение.",
  );

  const pages = async (path: string, field?: string) => {
    const items: any[] = [];
    let first: any = null;
    for (let page = 1; page <= 3; page++) {
      const response = await optional(`${path}?per_page=100&page=${page}`);
      if (page === 1) first = response;
      const list = field ? response?.[field] : response;
      if (!Array.isArray(list) || list.length > 100) return { items: null, first, complete: false };
      items.push(...list);
      if (list.length < 100) {
        const total = field === "check_runs" ? first?.total_count : undefined;
        return {
          items,
          first,
          complete:
            field !== "check_runs" || (Number.isSafeInteger(total) && total === items.length),
        };
      }
    }
    return { items, first, complete: false };
  };
  const [checkPages, statusPages, reviewPages, reviewCommentPages, issueCommentPages, commitPages] =
    await Promise.all([
      pages(`commits/${head.sha}/check-runs`, "check_runs"),
      pages(`commits/${head.sha}/status`, "statuses"),
      pages(`pulls/${number}/reviews`),
      pages(`pulls/${number}/comments`),
      pages(`issues/${number}/comments`),
      pages(`pulls/${number}/commits`),
    ]);
  const checks = { check_runs: checkPages.items };
  const statuses = { statuses: statusPages.items, state: statusPages.first?.state };
  const reviews = reviewPages.items;
  const reviewComments = reviewCommentPages.items;
  const issueComments = issueCommentPages.items;
  const commits = commitPages.items;
  const checkStates = ["queued", "in_progress", "completed", "waiting", "requested", "pending"];
  const conclusions = [
    "action_required",
    "cancelled",
    "failure",
    "neutral",
    "success",
    "skipped",
    "stale",
    "timed_out",
    "startup_failure",
  ];
  const statusStates = ["error", "failure", "pending", "success"];
  const validChecks =
    Array.isArray(checks.check_runs) &&
    checks.check_runs.every(
      (check: any) =>
        check &&
        typeof check.name === "string" &&
        check.name.length > 0 &&
        checkStates.includes(check.status) &&
        (check.status === "completed"
          ? conclusions.includes(check.conclusion)
          : check.conclusion === null),
    );
  const validStatuses =
    Array.isArray(statuses.statuses) &&
    statusStates.includes(statuses.state) &&
    statuses.statuses.every(
      (status: any) =>
        status &&
        typeof status.context === "string" &&
        status.context.length > 0 &&
        statusStates.includes(status.state),
    );
  if (!validChecks || !validStatuses)
    essential("Контекст CI неполон или недоступен; незавершённые проверки не считаются успешными.");
  if (!Array.isArray(reviews) || !Array.isArray(reviewComments) || !Array.isArray(issueComments))
    essential("Контекст предыдущих ревью или обсуждений неполон или недоступен.");
  const validCommits =
    Array.isArray(commits) &&
    commits.every(
      (commit: any) =>
        commit &&
        typeof commit === "object" &&
        fullSha(commit.sha) &&
        typeof commit.commit?.message === "string" &&
        commit.commit.message.trim().length > 0,
    );
  if (!validCommits) essential("История коммитов PR неполна или недоступна.");
  if (Array.isArray(commits) && commits.length >= 250)
    essential("История коммитов PR может быть усечена из-за лимита GitHub API в 250 коммитов.");
  if (
    [checkPages, statusPages, reviewPages, reviewCommentPages, issueCommentPages, commitPages].some(
      (page) => !page.complete,
    )
  )
    essential(
      "Контекст CI, предыдущих ревью или коммитов неполон или превысил лимит в 300 элементов на эндпоинт.",
    );

  const comments = (value: unknown) =>
    Array.isArray(value)
      ? value.map((comment) => ({
          author: text(comment?.user?.login),
          body: text(comment?.body),
          path: text(comment?.path),
          line: positive(comment?.line) ? comment.line : null,
          originalLine: positive(comment?.original_line) ? comment.original_line : null,
          side: text(comment?.side),
          commit: text(comment?.commit_id),
          diffHunk: text(comment?.diff_hunk),
          state: text(comment?.state),
          url: text(comment?.html_url),
        }))
      : null;
  const isRelease =
    object(pr.user).login === "calendar-release-ignateff-bot[bot]" &&
    object(pr.user).id === 351107404 &&
    object(pr.user).type === "Bot";
  const commitHistory = validCommits
    ? commits.map((commit: any) => ({
        sha: text(commit?.sha),
        message: text(commit?.commit?.message),
        author: text(commit?.author?.login),
      }))
    : null;

  const context = {
    schema: "gh-aw-review/v1",
    baseSha: base.sha,
    headSha: head.sha,
    pullRequest: {
      number,
      title: text(pr.title),
      body,
      author: text(object(pr.user).login),
      baseSha: base.sha,
      headSha: head.sha,
      isDraft: pr.draft !== false,
      isRelease,
    },
    criteria,
    baseDocs,
    changes,
    repository: repositoryContext,
    requirements: materials.length
      ? {
          availability: "available",
          text: JSON.stringify({ description: body, materials, baseDocs }),
        }
      : {
          availability: "unavailable",
          reason: "Связанные требования не удалось загрузить.",
          description: body,
          baseDocs,
        },
    agreement: { sources: agreements },
    limitations,
    ci: {
      headSha: head.sha,
      checks: Array.isArray(checks?.check_runs)
        ? checks.check_runs.map((check: any) => ({
            name: text(check?.name),
            status: text(check?.status),
            conclusion: text(check?.conclusion),
            url: text(check?.html_url),
          }))
        : null,
      status: statusPages.complete && validStatuses ? text(statuses?.state) : null,
      statuses: Array.isArray(statuses?.statuses)
        ? statuses.statuses.map((status: any) => ({
            context: text(status?.context),
            state: text(status?.state),
            url: text(status?.target_url),
          }))
        : null,
    },
    previousReview: {
      reviews: comments(reviews),
      reviewComments: comments(reviewComments),
      issueComments: comments(issueComments),
    },
    commits: commitHistory,
    isRelease,
  };
  if (truncated) essential("Часть текста контекста была усечена до 30000 символов.");
  if (aggregateTruncated)
    essential(
      "Необязательный текст контекста превысил суммарный лимит размера и был усечён; пропущенные свидетельства не могут подтвердить согласование или полноту.",
    );

  options.progress?.("final context validation started");
  const current = object(await request(`pulls/${number}`));
  if (object(current.head).sha !== head.sha || object(current.base).sha !== base.sha)
    throw new Error("PR head or base SHA changed during context collection");

  const materializationLimitations: string[] = [];
  const dataPath = (kind: string, ref: string, path: string) =>
    join(output, "data", kind, ...(ref ? [ref] : []), ...path.split("/"));
  const writeData = async (kind: string, ref: string, path: string, content: string | null) => {
    if (content === null) return;
    if (!safeRepositoryPath(path)) {
      materializationLimitations.push(`Файл ${path} не сохранён: небезопасный путь.`);
      return;
    }
    try {
      await writeFileSafely(dataPath(kind, ref, path), content);
    } catch {
      materializationLimitations.push(`Файл ${path} не удалось сохранить для чтения агентом.`);
    }
  };
  for (const change of changes) {
    if (typeof change.filename === "string") {
      if (change.baseSource !== null)
        await writeData(
          "changed",
          "base",
          change.previousFilename ?? change.filename,
          change.baseSource,
        );
      if (change.headSource !== null)
        await writeData("changed", "head", change.filename, change.headSource);
    }
  }
  for (const file of repositoryContext.related)
    await writeData("repository", "", file.path, file.content);
  for (const doc of baseDocs) await writeData("base", "base", doc.path, doc.body);

  for (const item of materializationLimitations)
    if (!context.limitations.includes(item)) context.limitations.push(item);

  const serialized = JSON.stringify(context);
  const redacted = [token]
    .filter(Boolean)
    .reduce(
      (value, secret) => value.split(JSON.stringify(secret).slice(1, -1)).join("[REDACTED]"),
      serialized,
    );
  if (Buffer.byteLength(redacted) > 6 * 1024 * 1024)
    throw new Error("Review context exceeds the snapshot limit");

  const meta: GhAwReviewMeta = {
    schema: "gh-aw-review-meta/v1",
    number,
    baseSha: base.sha,
    headSha: head.sha,
    runId: options.runId,
    runAttempt: options.runAttempt,
    artifact: `review-${options.runId}-${options.runAttempt}`,
    authorId: 41898282,
    limitations: context.limitations,
    repositoryAvailable: repositoryContext.available,
    isRelease,
  };
  await writeFileSafely(join(output, "snapshot.json"), redacted);
  await writeFileSafely(join(output, "meta.json"), JSON.stringify(meta));
  options.progress?.("context snapshot saved");
  return { snapshot: JSON.parse(redacted), meta };
}

if (import.meta.main) {
  try {
    const repository = process.env.GITHUB_REPOSITORY ?? "";
    const outputDirectory = process.env.GH_AW_CONTEXT_DIR || "review-context";
    const { snapshot, meta } = await collectGhAwReviewContext({
      fetch,
      repository,
      token: process.env.GH_TOKEN ?? "",
      number: Number(process.env.GH_AW_PR_NUMBER),
      expectedHeadSha: process.env.GH_AW_HEAD_SHA ?? "",
      runId: process.env.GITHUB_RUN_ID ?? "",
      runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? "",
      outputDirectory,
      progress: (stage) => console.log(`Контекст ревью: ${stage}`),
    });
    if (process.env.GITHUB_OUTPUT)
      await appendFile(
        process.env.GITHUB_OUTPUT,
        `head_sha=${meta.headSha}\nbase_sha=${meta.baseSha}\nnumber=${meta.number}\nartifact=${meta.artifact}\n`,
      );
    console.log(
      `Контекст ревью сохранён: изменений ${snapshot.changes.length}, ограничений ${meta.limitations.length}`,
    );
  } catch {
    console.error("Контекст ревью: закреплённый снимок не удалось собрать");
    process.exitCode = 1;
  }
}

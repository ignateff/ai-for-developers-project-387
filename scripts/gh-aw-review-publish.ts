import { createHash } from "node:crypto";
import { appendFile } from "node:fs/promises";

export type ReviewReport = {
  summary: string;
  findings: { file: string; line: number; conditions: string; consequence: string }[];
  limitations: string[];
};

export const reviewBodyLimit = 60000;
export const ghAwReportMarker = (sha: string, digest: string) =>
  `<!-- gh-aw-review-report:${sha}:${digest} -->`;

const escape = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/@/g, "@\u200b")
    .replace(/[\r\n]+/g, " ");

const text = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 12000;

export function validateReport(value: unknown): value is ReviewReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const report = value as Record<string, unknown>;
  if (!text(report.summary)) return false;
  if (!Array.isArray(report.limitations) || report.limitations.length > 100) return false;
  if (!report.limitations.every(text)) return false;
  if (!Array.isArray(report.findings) || report.findings.length > 100) return false;
  return report.findings.every((finding) => {
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) return false;
    const item = finding as Record<string, unknown>;
    return (
      text(item.file) &&
      Number.isSafeInteger(item.line) &&
      Number(item.line) > 0 &&
      text(item.conditions) &&
      text(item.consequence)
    );
  });
}

/** Read the single report emitted by the agent's custom safe-output tool. */
export function parseAgentReport(value: unknown): ReviewReport {
  const items = value && typeof value === "object" ? (value as any).items : null;
  if (!Array.isArray(items)) throw new Error("Agent output is not an items array");
  const matches = items.filter((item) => item?.type === "publish_review");
  if (matches.length !== 1 || typeof matches[0].report !== "string")
    throw new Error("Exactly one publish_review report is required");
  const report = JSON.parse(matches[0].report);
  if (!validateReport(report)) throw new Error("Agent report is malformed");
  return report;
}

export function formatGhAwReviewBody(options: {
  repository: string;
  sha: string;
  runId: string;
  report: ReviewReport;
  metaLimitations?: string[];
}) {
  const { repository, sha, runId, report } = options;
  const limitations = [...new Set([...report.limitations, ...(options.metaLimitations ?? [])])];
  const contextUnavailable = limitations.some((item) =>
    /(?:unavailable|incomplete|could not be loaded|недоступ|неполн|не удалось загрузить)/i.test(
      item,
    ),
  );
  const content = [
    `## Автоматическое ревью (gh-aw)`,
    `Проверенный head: \`${sha}\``,
    `Логи Actions: https://github.com/${repository}/actions/runs/${runId}`,
    "",
    contextUnavailable
      ? "**Ограничение: закреплённый контекст ревью был неполным или недоступным. Это не полное ревью кода.**"
      : "**Ревью носит рекомендательный характер и относится к закреплённому head-коммиту; ограничения контекста перечислены ниже.**",
    "",
    escape(report.summary),
    "",
    ...limitations.map((item) => `- Ограничение: ${escape(item)}`),
    ...report.findings.map(
      (finding) =>
        `- ${escape(finding.file)}:${finding.line} — ${escape(finding.conditions)}; ${escape(finding.consequence)}`,
    ),
  ].join("\n");
  const digest = createHash("sha256").update(content).digest("hex").slice(0, 16);
  return `${ghAwReportMarker(sha, digest)}\n${content}`;
}

export type PublishOptions = {
  fetch: typeof fetch;
  repository: string;
  token: string;
  authorId: number;
  number: number;
  sha: string;
  runId: string;
  runAttempt: string;
  report: ReviewReport;
  metaLimitations: string[];
  staged: boolean;
};

/** Verify head and publish exactly once; an identical report is a no-op. */
export async function publishGhAwReview(options: PublishOptions): Promise<string> {
  const { repository, token, authorId, number, sha, runId } = options;
  if (
    !/^[\w-]+\/[\w.-]+$/.test(repository) ||
    !token ||
    /[\r\n]/.test(token) ||
    !Number.isSafeInteger(authorId) ||
    authorId < 1 ||
    !Number.isSafeInteger(number) ||
    number < 1 ||
    !/^[a-f\d]{40}$/i.test(sha) ||
    !/^[1-9]\d*$/.test(runId) ||
    !/^[1-9]\d*$/.test(options.runAttempt) ||
    !Array.isArray(options.metaLimitations) ||
    options.metaLimitations.length > 100 ||
    !options.metaLimitations.every(
      (item) => typeof item === "string" && item.length > 0 && item.length <= 12000,
    ) ||
    !validateReport(options.report)
  )
    throw new Error("Invalid review publication input");

  const body = formatGhAwReviewBody({
    repository,
    sha,
    runId,
    report: options.report,
    metaLimitations: options.metaLimitations,
  });
  if (body.length > reviewBodyLimit)
    throw new Error("Тело ревью превышает лимит публикации; находки не были отброшены.");
  if (options.staged) return body;

  const base = `https://api.github.com/repos/${repository}`;
  const request = async (path: string, method = "GET", data?: unknown) => {
    const response = await options.fetch(`${base}/${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(10000),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(data ? { "Content-Type": "application/json" } : {}),
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    if (!response.ok) throw new Error("GitHub request failed");
    return response.json();
  };
  const assertHead = async () => {
    const pr = await request(`pulls/${number}`);
    if (
      !pr ||
      pr.number !== number ||
      pr.state !== "open" ||
      pr.head?.sha !== sha ||
      (pr.head?.repo?.full_name &&
        pr.head.repo.full_name.toLowerCase() !== repository.toLowerCase()) ||
      (pr.base?.repo?.full_name &&
        pr.base.repo.full_name.toLowerCase() !== repository.toLowerCase())
    )
      throw new Error("PR head is stale; the pinned review was not published");
  };

  const marker = body.split("\n")[0];
  await assertHead();
  for (let page = 1; page <= 1000; page++) {
    const comments = await request(`issues/${number}/comments?per_page=100&page=${page}`);
    if (!Array.isArray(comments)) throw new Error("Invalid comments response");
    if (
      comments.some(
        (comment) =>
          comment?.user?.id === authorId &&
          typeof comment.body === "string" &&
          comment.body.startsWith(`${marker}\n`),
      )
    )
      return "already-published";
    if (comments.length < 100) break;
    if (page === 1000) throw new Error("Comment pagination limit reached");
  }
  await assertHead();
  await request(`issues/${number}/comments`, "POST", { body });
  return "published";
}

export async function writeReviewPublicationSummary(
  body: string,
  env: NodeJS.ProcessEnv,
  write: (path: string, text: string) => Promise<void> = appendFile,
) {
  if (!env.GITHUB_STEP_SUMMARY) return;
  await write(
    env.GITHUB_STEP_SUMMARY,
    `### Черновик авторевью (staged)\n\nПубликация не выполнялась.\n\n${body}\n`,
  );
}

if (import.meta.main) {
  try {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const directory = process.env.GH_AW_CONTEXT_DIR || "review-context";
    const meta = JSON.parse(await readFile(join(directory, "meta.json"), "utf8"));
    const agentOutput = JSON.parse(await readFile(process.env.GH_AW_AGENT_OUTPUT ?? "", "utf8"));
    const report = parseAgentReport(agentOutput);
    const staged =
      process.env.GH_AW_SAFE_OUTPUTS_STAGED === "true" ||
      process.env.GITHUB_EVENT_NAME === "workflow_dispatch";
    const result = await publishGhAwReview({
      fetch,
      repository: process.env.GITHUB_REPOSITORY ?? "",
      token: process.env.GH_TOKEN ?? "",
      authorId: meta.authorId ?? 41898282,
      number: meta.number,
      sha: meta.headSha,
      runId: meta.runId,
      runAttempt: meta.runAttempt,
      report,
      metaLimitations: Array.isArray(meta.limitations) ? meta.limitations : [],
      staged,
    });
    if (staged) await writeReviewPublicationSummary(result, process.env);
    else console.log(`Авторевью: ${result}`);
  } catch {
    console.error("Авторевью: публикация не выполнена; требуется внимание человека");
    process.exitCode = 1;
  }
}

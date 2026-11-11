export type Report =
  | {
      summary: string;
      limitations: string[];
      publicationLimitations?: string[];
      findings: { file: string; line: number; conditions: string; consequence: string }[];
      publicationLimit?: true;
    }
  | { failure: "infra" | "timeout" | "agent_failed" };

export const reviewBodyLimit = 60000;

const failureLabels = {
  infra: "инфраструктурная ошибка",
  timeout: "таймаут",
  agent_failed: "сбой агента",
} as const;

export function formatReviewBody(
  repository: string,
  sha: string,
  artifact: string,
  report: Report,
) {
  const marker = `<!-- opencode-review-report:${artifact} -->`;
  const safe = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/@/g, "@\u200b")
      .replace(/[\r\n]+/g, " ");
  const contextUnavailable =
    !("failure" in report) &&
    (report.publicationLimitations ?? report.limitations).some((item) =>
      // Older artifacts contain English limitation text. Keep recognizing it so
      // republishing a saved review still shows the non-full-review warning.
      /(?:unavailable|incomplete|could not be loaded|недоступ|неполн|не удалось загрузить)/i.test(
        item,
      ),
    );
  return [
    marker,
    `## Автоматическое ревью OpenCode`,
    `Проверенный head: \`${sha}\``,
    `Логи Actions: https://github.com/${repository}/actions/runs/${artifact.split("-")[1]}/attempts/${artifact.split("-")[2]}`,
    "",
    ...("failure" in report
      ? [
          `**Ревью остановлено: ${failureLabels[report.failure]} (${report.failure}). Требуется вмешательство человека.**`,
        ]
      : report.publicationLimit
        ? [
            `**Требуется вмешательство человека: находки не включены в этот комментарий, потому что ревью или существенный контекст превышает лимит публикации. Скачайте артефакт \`${artifact}\` из запуска Actions по ссылке выше и откройте его review.json, чтобы увидеть полный список находок и ограничений.**`,
          ]
        : [
            contextUnavailable
              ? "**Ограничение: закреплённый контекст ревью был неполным или недоступным. Это не полное ревью кода.**"
              : "**Ревью носит рекомендательный характер и относится к закреплённому head-коммиту; ограничения контекста перечислены ниже.**",
            "",
            safe(report.summary),
            "",
            ...(report.publicationLimitations ?? report.limitations).map(
              (s) => `- Ограничение: ${safe(s)}`,
            ),
            ...report.findings.map(
              (f) => `- ${safe(f.file)}:${f.line} — ${safe(f.conditions)}; ${safe(f.consequence)}`,
            ),
          ]),
  ].join("\n");
}

/** Publication is separate from model invocation and safe to retry with the same artifact. */
export async function publishReview(options: {
  fetch: typeof fetch;
  repository: string;
  token: string;
  authorId: number;
  number: number;
  sha: string;
  artifact: string;
  report: Report;
}) {
  const { repository, token, authorId, number, sha, artifact, report } = options;
  const text = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0 && value.length <= 12000;
  const nonempty = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  if (
    !/^[\w-]+\/[\w.-]+$/.test(repository) ||
    !token ||
    /[\r\n]/.test(token) ||
    !Number.isSafeInteger(authorId) ||
    authorId < 1 ||
    !Number.isSafeInteger(number) ||
    number < 1 ||
    !/^[a-f\d]{40}$/i.test(sha) ||
    !/^review-[1-9]\d*-[1-9]\d*$/.test(artifact) ||
    !report ||
    !("failure" in report
      ? ["infra", "timeout", "agent_failed"].includes(report.failure)
      : text(report.summary) &&
        Array.isArray(report.limitations) &&
        report.limitations.every(nonempty) &&
        (report.publicationLimit === true ||
          (Array.isArray(report.publicationLimitations ?? report.limitations) &&
            (report.publicationLimitations ?? report.limitations).length <= 100 &&
            (report.publicationLimitations ?? report.limitations).every(text))) &&
        Array.isArray(report.findings) &&
        (report.publicationLimit === true || report.findings.length <= 100) &&
        report.findings.every(
          (f) =>
            f &&
            (report.publicationLimit === true ? nonempty(f.file) : text(f.file)) &&
            Number.isSafeInteger(f.line) &&
            f.line > 0 &&
            (report.publicationLimit === true ? nonempty(f.conditions) : text(f.conditions)) &&
            (report.publicationLimit === true ? nonempty(f.consequence) : text(f.consequence)),
        ))
  )
    throw new Error();
  const base = `https://api.github.com/repos/${repository}`;
  const request = async (path: string, method = "GET", body?: string) => {
    const response = await options.fetch(`${base}/${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(10000),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify({ body }) } : {}),
    });
    if (!response.ok) throw new Error();
    return response.json();
  };
  const assertHead = async () => {
    const pr = await request(`pulls/${number}`);
    if (pr?.number !== number || pr?.head?.sha !== sha) throw new Error();
  };
  await assertHead();
  const marker = `<!-- opencode-review-report:${artifact} -->`;
  for (let page = 1; page <= 1000; page++) {
    const comments = await request(`issues/${number}/comments?per_page=100&page=${page}`);
    if (!Array.isArray(comments)) throw new Error();
    if (
      comments.some(
        (comment) =>
          comment?.user?.id === authorId &&
          typeof comment.body === "string" &&
          comment.body.startsWith(`${marker}\n`),
      )
    )
      return;
    if (comments.length < 100) break;
    if (page === 1000) throw new Error();
  }
  const body = formatReviewBody(repository, sha, artifact, report);
  if (body.length > reviewBodyLimit)
    throw new Error("Тело ревью превышает лимит публикации; находки не были отброшены.");
  await assertHead();
  await request(`issues/${number}/comments`, "POST", body);
}

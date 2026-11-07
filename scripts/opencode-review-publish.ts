export type Report =
  | {
      summary: string;
      limitations: string[];
      findings: { file: string; line: number; conditions: string; consequence: string }[];
      publicationLimit?: true;
    }
  | { failure: "infra" | "timeout" | "agent_failed" };

export const reviewBodyLimit = 60000;

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
  return [
    marker,
    `## OpenCode review`,
    `Head: \`${sha}\``,
    `Actions logs: https://github.com/${repository}/actions/runs/${artifact.split("-")[1]}/attempts/${artifact.split("-")[2]}`,
    "",
    ...("failure" in report
      ? [`**Review stopped: ${report.failure}. Human attention required.**`]
      : report.publicationLimit
        ? [
            `**Human attention required: findings are not included in this comment because the complete review exceeds the publication size limit. Download artifact \`${artifact}\` from the Actions run linked above and inspect its review.json for the complete findings and limitations.**`,
          ]
        : [
            "**Limitation: Full base/head source snapshots were unavailable. This is not a full code review.**",
            "",
            safe(report.summary),
            "",
            ...report.limitations.map((s) => `- Limitation: ${safe(s)}`),
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
        (report.publicationLimit === true || report.limitations.length <= 100) &&
        report.limitations.every(text) &&
        Array.isArray(report.findings) &&
        report.findings.length <= 100 &&
        report.findings.every(
          (f) =>
            f &&
            text(f.file) &&
            Number.isSafeInteger(f.line) &&
            f.line > 0 &&
            text(f.conditions) &&
            text(f.consequence),
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
    throw new Error("Review body exceeds the publication size limit; findings were not discarded.");
  await assertHead();
  await request(`issues/${number}/comments`, "POST", body);
}

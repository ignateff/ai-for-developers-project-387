import { appendFile } from "node:fs/promises";

export const ghAwReviewBudgetMarker = "<!-- gh-aw-review-attempt-budget:v1 -->";
export const githubActionsBotId = 41898282;
export const reviewAttemptLimit = 3;

export type ReviewBudgetDecision =
  | { admitted: true; reason: "admitted"; count: number }
  | {
      admitted: false;
      reason: "limit_exhausted" | "stale" | "draft" | "closed";
      count?: number;
    };

export type ReviewBudgetOptions = {
  fetch: typeof fetch;
  repository: string;
  token: string;
  number: number;
  expectedHeadSha: string;
  authorId: number;
};

const object = (value: unknown): Record<string, any> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : {};

const request = async (
  options: ReviewBudgetOptions,
  path: string,
  method = "GET",
  data?: unknown,
) => {
  const response = await options.fetch(
    `https://api.github.com/repos/${options.repository}/${path}`,
    {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(10000),
      headers: {
        Authorization: `Bearer ${options.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(data ? { "Content-Type": "application/json" } : {}),
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    },
  );
  if (!response.ok) throw new Error("GitHub request failed");
  return response.json();
};

const stateBody = (count: number) =>
  `${ghAwReviewBudgetMarker}\n${JSON.stringify({ review: count })}`;

/** Re-check the live PR and atomically-enough increment the new review counter. */
export async function admitReviewAttempt(
  options: ReviewBudgetOptions,
): Promise<ReviewBudgetDecision> {
  if (
    !/^[\w-]+\/[\w.-]+$/.test(options.repository) ||
    !options.token ||
    /[\r\n]/.test(options.token) ||
    !Number.isSafeInteger(options.number) ||
    options.number < 1 ||
    !/^[a-f\d]{40}$/i.test(options.expectedHeadSha) ||
    !Number.isSafeInteger(options.authorId) ||
    options.authorId < 1
  )
    throw new Error("Invalid review budget input");

  const pr = object(await request(options, `pulls/${options.number}`));
  const head = object(pr.head);
  if (pr.number !== options.number || pr.state !== "open") {
    return { admitted: false, reason: "closed" };
  }
  if (pr.draft !== false) return { admitted: false, reason: "draft" };
  if (head.sha !== options.expectedHeadSha) return { admitted: false, reason: "stale" };

  const found: Record<string, any>[] = [];
  for (let page = 1; page <= 1000; page++) {
    const comments = await request(
      options,
      `issues/${options.number}/comments?per_page=100&page=${page}`,
    );
    if (!Array.isArray(comments)) throw new Error("Invalid comments response");
    for (const item of comments) {
      const comment = object(item);
      if (
        object(comment.user).id === options.authorId &&
        typeof comment.body === "string" &&
        comment.body.includes(ghAwReviewBudgetMarker)
      )
        found.push(comment);
    }
    if (comments.length < 100) break;
    if (page === 1000) throw new Error("Comment pagination limit reached");
  }
  if (found.length > 1) throw new Error("Ambiguous review budget state");

  let comment = found[0];
  if (!comment) {
    comment = object(
      await request(options, `issues/${options.number}/comments`, "POST", {
        body: stateBody(1),
      }),
    );
    if (
      !Number.isSafeInteger(comment.id) ||
      comment.id < 1 ||
      object(comment.user).id !== options.authorId ||
      comment.body !== stateBody(1)
    )
      throw new Error("Review budget state was not created authoritatively");
    return { admitted: true, reason: "admitted", count: 1 };
  }

  if (!Number.isSafeInteger(comment.id) || comment.id < 1)
    throw new Error("Invalid review budget comment");
  const match = /^<!-- gh-aw-review-attempt-budget:v1 -->\n(\{"review":(\d+)\})$/.exec(
    comment.body,
  );
  if (!match) throw new Error("Malformed review budget state");
  const count = Number(match[2]);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("Malformed review budget counter");
  if (count >= reviewAttemptLimit) return { admitted: false, reason: "limit_exhausted", count };
  const next = count + 1;
  await request(options, `issues/comments/${comment.id}`, "PATCH", { body: stateBody(next) });
  return { admitted: true, reason: "admitted", count: next };
}

export async function writeReviewBudgetOutput(
  decision: ReviewBudgetDecision,
  env: NodeJS.ProcessEnv,
  write: (path: string, text: string) => Promise<void> = appendFile,
) {
  const lines = [
    `admitted=${decision.admitted}`,
    `reason=${decision.reason}`,
    `count=${decision.count ?? ""}`,
  ];
  if (env.GITHUB_OUTPUT) await write(env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  if (env.GITHUB_STEP_SUMMARY) {
    const message = decision.admitted
      ? `Попытка ревью №${decision.count} из ${reviewAttemptLimit} допущена.`
      : decision.reason === "limit_exhausted"
        ? `Бюджет автоматического ревью исчерпан: ${reviewAttemptLimit} из ${reviewAttemptLimit} попыток уже допущено. Модель не вызывалась.`
        : decision.reason === "stale"
          ? "Head PR изменился до допуска. Устаревшее ревью отменено без расхода попытки."
          : decision.reason === "draft"
            ? "Черновик пропущен без расхода попытки."
            : "PR закрыт; попытка не потрачена.";
    await write(env.GITHUB_STEP_SUMMARY, `### Бюджет авторевью\n\n${message}\n`);
  }
}

if (import.meta.main) {
  try {
    const decision = await admitReviewAttempt({
      fetch,
      repository: process.env.GITHUB_REPOSITORY ?? "",
      token: process.env.GH_TOKEN ?? "",
      number: Number(process.env.GH_AW_PR_NUMBER),
      expectedHeadSha: process.env.GH_AW_HEAD_SHA ?? "",
      authorId: githubActionsBotId,
    });
    await writeReviewBudgetOutput(decision, process.env);
    if (!decision.admitted) console.log(`Авторевью не допущено: ${decision.reason}`);
  } catch {
    console.error("Бюджет авторевью: состояние недоступно или повреждено; модель не вызывалась");
    process.exitCode = 1;
  }
}

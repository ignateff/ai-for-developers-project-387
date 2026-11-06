import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";

const marker = "<!-- opencode-pr-budget-lock:v1 -->";

/** Best-effort cross-runner queue. A cancelled owner can leave a claim requiring human removal. */
export function createCommentBudgetLock(options: {
  fetch: typeof fetch;
  repository: string;
  token: string;
  authorId: number;
  delay?: () => Promise<void>;
}) {
  return async <T>(key: string, action: () => Promise<T>): Promise<T> => {
    const prefix = `${options.repository.toLowerCase()}#`;
    const number = key.startsWith(prefix) ? key.slice(prefix.length) : "";
    if (
      !/^[\w-]+\/[\w.-]+$/.test(options.repository) ||
      !/^[1-9]\d*$/.test(number) ||
      !Number.isSafeInteger(Number(number)) ||
      !options.token ||
      /[\r\n]/.test(options.token) ||
      !Number.isSafeInteger(options.authorId) ||
      options.authorId < 1
    )
      throw new Error();
    const base = `https://api.github.com/repos/${options.repository}`;
    const request = async (path: string, method = "GET", body?: string) => {
      const response = await options.fetch(`${base}/${path}`, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(10000),
        headers: {
          Authorization: `Bearer ${options.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify({ body }) } : {}),
      });
      if (!response.ok) throw new Error();
      return response.status === 204 ? null : response.json();
    };
    const body = `${marker}\n${randomUUID()}`;
    let claim;
    try {
      claim = await request(`issues/${number}/comments`, "POST", body);
      if (
        !Number.isSafeInteger(claim?.id) ||
        claim.id < 1 ||
        claim.user?.id !== options.authorId ||
        claim.body !== body
      )
        throw new Error();
    } catch {
      console.error(
        `OpenCode budget lock: PR #${number} creation outcome unknown; human must inspect orphaned locks`,
      );
      throw new Error();
    }
    try {
      for (let attempt = 0; attempt < 30; attempt++) {
        let seen = false;
        let ahead = false;
        for (let page = 1; page <= 1000; page++) {
          const comments = await request(`issues/${number}/comments?per_page=100&page=${page}`);
          if (!Array.isArray(comments)) throw new Error();
          for (const comment of comments) {
            if (
              comment?.user?.id !== options.authorId ||
              typeof comment.body !== "string" ||
              !comment.body.includes(marker)
            )
              continue;
            if (
              !Number.isSafeInteger(comment.id) ||
              comment.id < 1 ||
              !/^<!-- opencode-pr-budget-lock:v1 -->\n[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/.test(
                comment.body,
              )
            )
              throw new Error();
            if (comment.id === claim.id && comment.body === body) seen = true;
            else if (comment.id <= claim.id) ahead = true;
          }
          if (comments.length < 100) break;
          if (page === 1000) throw new Error();
        }
        if (!seen) throw new Error();
        if (!ahead) return await action();
        await (options.delay ?? (() => wait(1000)))();
      }
      throw new Error();
    } finally {
      await request(`issues/comments/${claim.id}`, "DELETE");
    }
  };
}

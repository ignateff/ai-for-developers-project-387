import { authorizeComment } from "./opencode-trust.ts";
import { ReviewFailure } from "./opencode-review-failure.ts";

const marker = "<!-- opencode-pr-attempt-budget:v1 -->";
const queues = new Map<string, Promise<void>>();
type RecordValue = Record<string, any>;
const obj = (value: unknown): RecordValue =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : {};
const positive = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) > 0;
const approvedReviewBots = new Map<number, string>([
  [219766164, "opencode-agent[bot]"],
  [351107404, "calendar-release-ignateff-bot[bot]"],
]);

export type Options = {
  kind: "command" | "review";
  eventName: string;
  event: unknown;
  repository: string;
  owner: string;
  token: string;
  authorId: number;
  actionsUrl: string;
  allowedAppIds?: number[];
};
export type Dependencies = {
  fetch: typeof fetch;
  prepare: () => Promise<void>;
  model: (identity: { number?: number; sha?: string }) => Promise<void>;
  // A shared cross-runner lock is required in addition to the local queue.
  withLock?: <T>(key: string, action: () => Promise<T>) => Promise<T>;
};
type Result = { status: string; number?: number; sha?: string; actionsUrl?: string };

async function locallySerialized<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  queues.set(key, current);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (queues.get(key) === current) queues.delete(key);
  }
}

/** Workflow boundary: dependencies belong to trusted base code, never PR content. */
export function createBudgetWorkflow(deps: Dependencies) {
  return async (options: Options): Promise<Result> => {
    const { repository, owner, token, eventName } = options;
    if (
      !/^[\w-]+\/[\w.-]+$/.test(repository) ||
      repository.split("/")[0].toLowerCase() !== owner.toLowerCase() ||
      !positive(options.authorId) ||
      !token ||
      /[\r\n]/.test(token)
    )
      return { status: "infra" };
    const event = obj(options.event);
    const prEvent = obj(event.pull_request);
    const issue = obj(event.issue);
    const isPr =
      options.kind === "review" ||
      eventName === "pull_request_review_comment" ||
      Object.hasOwn(issue, "pull_request");
    const number: unknown =
      options.kind === "review" || eventName === "pull_request_review_comment"
        ? prEvent.number
        : issue.number;
    if (!positive(number)) return { status: "infra" };
    const base = `https://api.github.com/repos/${repository}`;
    const request = async (path: string, method = "GET", data?: unknown): Promise<any> => {
      const response = await deps.fetch(`${base}/${path}`, {
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
    let admittedSha: string | undefined;
    try {
      if (options.kind === "command") {
        if (obj(obj(event.comment).user).type !== "User") return { status: "skipped" };
        const decision = await authorizeComment({
          eventName,
          event,
          repository,
          owner,
          token,
          fetch: deps.fetch,
        });
        if (!decision.allowed)
          return { status: decision.reason === "github-error" ? "infra" : "skipped" };
      } else {
        if (
          eventName !== "pull_request" ||
          !["opened", "synchronize", "reopened", "ready_for_review"].includes(event.action) ||
          obj(event.repository).full_name?.toLowerCase() !== repository.toLowerCase()
        )
          return { status: "skipped" };
      }
      let sha: string | undefined;
      if (isPr) {
        const pr = obj(await request(`pulls/${number}`));
        const head = obj(pr.head),
          baseRepo = obj(obj(pr.base).repo),
          headRepo = obj(head.repo),
          author = obj(pr.user);
        if (
          pr.number !== number ||
          pr.state !== "open" ||
          !positive(baseRepo.id) ||
          baseRepo.id !== headRepo.id ||
          baseRepo.full_name?.toLowerCase() !== repository.toLowerCase() ||
          headRepo.full_name?.toLowerCase() !== repository.toLowerCase() ||
          typeof head.sha !== "string" ||
          !/^[a-f\d]{40}$/i.test(head.sha)
        )
          return { status: "skipped" };
        sha = head.sha;
        if (options.kind === "review") {
          if (pr.draft !== false) return { status: "skipped" };
          if (author.type === "Bot") {
            if (
              !positive(author.id) ||
              !options.allowedAppIds?.includes(author.id) ||
              !approvedReviewBots.has(author.id) ||
              approvedReviewBots.get(author.id) !== author.login
            )
              return { status: "skipped" };
          } else if (
            author.type !== "User" ||
            typeof author.login !== "string" ||
            !/^[a-z\d-]+$/i.test(author.login)
          )
            return { status: "skipped" };
          else if (author.login.toLowerCase() !== owner.toLowerCase()) {
            const permission = obj(
              await request(`collaborators/${encodeURIComponent(author.login)}/permission`),
            ).permission;
            if (!["admin", "maintain", "write"].includes(permission)) return { status: "skipped" };
          }
        }
        const key = `${repository.toLowerCase()}#${number}`;
        const admit = async () => {
          const found: RecordValue[] = [];
          for (let page = 1; page <= 1000; page++) {
            const comments = await request(`issues/${number}/comments?per_page=100&page=${page}`);
            if (!Array.isArray(comments)) throw new Error();
            for (const item of comments) {
              const comment = obj(item);
              if (
                obj(comment.user).id === options.authorId &&
                typeof comment.body === "string" &&
                comment.body.includes(marker)
              )
                found.push(comment);
            }
            if (comments.length < 100) break;
            if (page === 1000) throw new Error();
          }
          if (found.length > 1) throw new Error();
          let comment = found[0];
          if (!comment)
            comment = obj(
              await request(`issues/${number}/comments`, "POST", {
                body: `${marker}\n${JSON.stringify({ command: 0, review: 0 })}`,
              }),
            );
          if (
            !positive(comment.id) ||
            obj(comment.user).id !== options.authorId ||
            typeof comment.body !== "string"
          )
            throw new Error();
          const match =
            /^<!-- opencode-pr-attempt-budget:v1 -->\n(\{"command":\d+,"review":\d+\})$/.exec(
              comment.body,
            );
          if (!match) throw new Error();
          const counts = JSON.parse(match[1]);
          if (![counts.command, counts.review].every((n) => Number.isSafeInteger(n) && n >= 0))
            throw new Error();
          if (counts[options.kind] >= 3) return false;
          counts[options.kind]++;
          await request(`issues/comments/${comment.id}`, "PATCH", {
            body: `${marker}\n${JSON.stringify(counts)}`,
          });
          return true;
        };
        const allowed = await locallySerialized(key, () =>
          deps.withLock ? deps.withLock(key, admit) : admit(),
        );
        if (!allowed) {
          const validUrl = new RegExp(
            `^https://github\\.com/${repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/actions/runs/\\d+$`,
            "i",
          );
          return {
            status: "limit_exhausted",
            number,
            sha,
            ...(validUrl.test(options.actionsUrl) ? { actionsUrl: options.actionsUrl } : {}),
          };
        }
        admittedSha = sha;
      }
      await deps.prepare();
      await deps.model(isPr ? { number, sha } : {});
      return { status: "completed", ...(isPr ? { number, sha } : {}) };
    } catch (error) {
      const status = error instanceof ReviewFailure ? error.reason : "infra";
      return { status, ...(isPr ? { number } : {}), ...(admittedSha ? { sha: admittedSha } : {}) };
    }
  };
}

import { appendFile, readFile } from "node:fs/promises";

type Decision = { allowed: boolean; number?: number; reason: string };

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function sameName(value: unknown, expected: string): boolean {
  return typeof value === "string" && value.toLowerCase() === expected.toLowerCase();
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export async function authorizeComment(options: {
  eventName: string;
  event: unknown;
  repository: string;
  owner: string;
  token: string;
  fetch?: typeof fetch;
}): Promise<Decision> {
  const { repository, owner, token, eventName } = options;
  const account = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?(?:\[bot\])?$/i;
  if (
    !["issue_comment", "pull_request_review_comment"].includes(eventName) ||
    !/^[a-z\d-]+\/[a-z\d_.-]{1,100}$/i.test(repository) ||
    !account.test(owner) ||
    !sameName(repository.split("/")[0], owner) ||
    [".", ".."].includes(repository.split("/")[1]) ||
    typeof token !== "string" ||
    !token.trim() ||
    /[\r\n]/.test(token)
  ) {
    return { allowed: false, reason: "invalid-input" };
  }
  const event = object(options.event);
  const eventRepository = object(event.repository);
  const comment = object(event.comment);
  const author = object(comment.user).login;
  const issue = object(event.issue);
  const isPr = eventName === "pull_request_review_comment" || Object.hasOwn(issue, "pull_request");
  const number = eventName === "issue_comment" ? issue.number : object(event.pull_request).number;
  if (
    event.action !== "created" ||
    !sameName(eventRepository.full_name, repository) ||
    !sameName(object(eventRepository.owner).login, owner) ||
    typeof author !== "string" ||
    !account.test(author) ||
    !positiveInteger(number) ||
    (eventName === "issue_comment" &&
      isPr &&
      (issue.pull_request === null ||
        typeof issue.pull_request !== "object" ||
        Array.isArray(issue.pull_request)))
  ) {
    return { allowed: false, reason: "invalid-event" };
  }
  if (typeof comment.body !== "string" || !/(?:^|\s)\/(?:oc|opencode)(?=\s|$)/.test(comment.body)) {
    return { allowed: false, number, reason: "not-command" };
  }
  try {
    const get = async (resource: string) => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          (async () => {
            const response = await (options.fetch ?? fetch)(
              `https://api.github.com/repos/${repository}/${resource}`,
              {
                method: "GET",
                headers: {
                  Authorization: `Bearer ${token}`,
                  Accept: "application/vnd.github+json",
                  "X-GitHub-Api-Version": "2022-11-28",
                },
                redirect: "error",
                signal: controller.signal,
              },
            );
            if (response.status !== 200) throw new Error("GitHub request failed");
            return object(await response.json());
          })(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("GitHub request timed out")), 10000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
    };
    if (isPr) {
      // Event metadata (including issue_comment's PR URL) is not authoritative.
      const pr = await get(`pulls/${number}`);
      const base = object(object(pr.base).repo);
      const head = object(object(pr.head).repo);
      if (
        pr.number !== number ||
        !positiveInteger(base.id) ||
        !positiveInteger(head.id) ||
        base.id !== head.id ||
        !sameName(base.full_name, repository) ||
        !sameName(head.full_name, repository)
      ) {
        return { allowed: false, number, reason: "unsafe-pull-request" };
      }
    }
    if (sameName(author, owner)) {
      return { allowed: true, number, reason: "authorized" };
    }
    const permission = (await get(`collaborators/${encodeURIComponent(author)}/permission`))
      .permission;
    const allowed =
      typeof permission === "string" && ["admin", "maintain", "write"].includes(permission);
    return { allowed, number, reason: allowed ? "authorized" : "insufficient-permission" };
  } catch {
    // Never include request errors or API bodies: either can contain credentials.
    return { allowed: false, number, reason: "github-error" };
  }
}

if (import.meta.main) {
  let decision: Decision;
  try {
    decision = await authorizeComment({
      eventName: process.env.GITHUB_EVENT_NAME ?? "",
      event: JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH ?? "", "utf8")),
      repository: process.env.GITHUB_REPOSITORY ?? "",
      owner: process.env.GITHUB_REPOSITORY_OWNER ?? "",
      token: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? "",
    });
  } catch {
    decision = { allowed: false, reason: "invalid-event-file" };
    process.exitCode = 1;
  }
  try {
    await appendFile(
      process.env.GITHUB_OUTPUT ?? "",
      `allowed=${decision.allowed}\nnumber=${decision.number ?? ""}\nreason=${decision.reason}\n`,
    );
    console.log(`OpenCode trust: ${decision.reason}`);
  } catch {
    console.error("OpenCode trust: unable to write decision");
    process.exitCode = 1;
  }
}

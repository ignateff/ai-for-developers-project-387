import { appendFile } from "node:fs/promises";

export const reviewBots = new Map<number, string>([
  [219766164, "opencode-agent[bot]"],
  [351107404, "calendar-release-ignateff-bot[bot]"],
]);

export type EligibilityReason =
  | "allowed"
  | "invalid-input"
  | "invalid-pr"
  | "draft"
  | "closed"
  | "fork"
  | "untrusted-author"
  | "infra";

export type Eligibility =
  | {
      allowed: true;
      reason: "allowed";
      number: number;
      headSha: string;
      baseSha: string;
    }
  | { allowed: false; reason: Exclude<EligibilityReason, "allowed"> };

export type EligibilityOptions = {
  fetch: typeof fetch;
  repository: string;
  owner: string;
  token: string;
  number: number;
};

const object = (value: unknown): Record<string, any> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : {};

const fullSha = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f\d]{40}$/i.test(value);

const login = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(value);

/** Decide admission from trusted base tooling before any attempt or model call. */
export async function evaluateEligibility(options: EligibilityOptions): Promise<Eligibility> {
  const { repository, owner, token, number } = options;
  if (
    !/^[\w-]+\/[\w.-]+$/.test(repository) ||
    repository.split("/")[0].toLowerCase() !== owner.toLowerCase() ||
    !token ||
    /[\r\n]/.test(token) ||
    !Number.isSafeInteger(number) ||
    number < 1
  )
    return { allowed: false, reason: "invalid-input" };
  try {
    const response = await options.fetch(
      `https://api.github.com/repos/${repository}/pulls/${number}`,
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
    if (!response.ok) return { allowed: false, reason: "infra" };
    const pr = object(await response.json());
    const base = object(pr.base);
    const head = object(pr.head);
    const baseRepo = object(base.repo);
    const headRepo = object(head.repo);
    if (
      pr.number !== number ||
      !fullSha(base.sha) ||
      !fullSha(head.sha) ||
      !Number.isSafeInteger(baseRepo.id) ||
      baseRepo.id < 1
    )
      return { allowed: false, reason: "invalid-pr" };
    if (
      baseRepo.id !== headRepo.id ||
      baseRepo.full_name?.toLowerCase() !== repository.toLowerCase() ||
      headRepo.full_name?.toLowerCase() !== repository.toLowerCase()
    )
      return { allowed: false, reason: "fork" };
    if (pr.state !== "open") return { allowed: false, reason: "closed" };
    if (pr.draft !== false) return { allowed: false, reason: "draft" };

    const author = object(pr.user);
    if (author.type === "Bot") {
      if (!Number.isSafeInteger(author.id) || reviewBots.get(author.id) !== author.login)
        return { allowed: false, reason: "untrusted-author" };
    } else {
      if (author.type !== "User" || !login(author.login))
        return { allowed: false, reason: "untrusted-author" };
      if (author.login.toLowerCase() !== owner.toLowerCase()) {
        const permissionResponse = await options.fetch(
          `https://api.github.com/repos/${repository}/collaborators/${encodeURIComponent(author.login)}/permission`,
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
        if (!permissionResponse.ok) return { allowed: false, reason: "infra" };
        const permission = object(await permissionResponse.json()).permission;
        if (!["admin", "maintain", "write"].includes(permission))
          return { allowed: false, reason: "untrusted-author" };
      }
    }
    return {
      allowed: true,
      reason: "allowed",
      number,
      headSha: head.sha,
      baseSha: base.sha,
    };
  } catch {
    return { allowed: false, reason: "infra" };
  }
}

const messages: Record<Eligibility["reason"], string> = {
  allowed: "PR допущен к автоматическому ревью.",
  "invalid-input":
    "Номер PR или входные данные недопустимы. Модель не вызывалась, попытка не потрачена.",
  "invalid-pr": "Данные PR неполны или изменились. Модель не вызывалась, попытка не потрачена.",
  draft: "Черновик пропущен. Модель не вызывалась, попытка не потрачена.",
  closed: "PR закрыт, поэтому ревью пропущено. Модель не вызывалась, попытка не потрачена.",
  fork: "PR из другого репозитория или форка. Модель не вызывалась, попытка не потрачена.",
  "untrusted-author":
    "Автор PR не имеет текущих прав admin, maintain или write и не входит в разрешённые боты. Модель не вызывалась, попытка не потрачена.",
  infra:
    "Не удалось проверить происхождение или права автора PR. Модель не вызывалась, попытка не потрачена.",
};

/** Write the step outputs and a Russian skip reason without throwing. */
export async function writeEligibilityOutput(
  decision: Eligibility,
  env: NodeJS.ProcessEnv,
  write: (path: string, text: string) => Promise<void> = appendFile,
) {
  const lines = [
    `allowed=${decision.allowed}`,
    `reason=${decision.reason}`,
    `number=${decision.allowed ? decision.number : ""}`,
    `head_sha=${decision.allowed ? decision.headSha : ""}`,
    `base_sha=${decision.allowed ? decision.baseSha : ""}`,
  ];
  if (env.GITHUB_OUTPUT) await write(env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  if (env.GITHUB_STEP_SUMMARY)
    await write(env.GITHUB_STEP_SUMMARY, `### Допуск авторевью\n\n${messages[decision.reason]}\n`);
}

if (import.meta.main) {
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const number = Number(process.env.GH_AW_PR_NUMBER);
  const decision = await evaluateEligibility({
    fetch,
    repository,
    owner: repository.split("/")[0] ?? "",
    token: process.env.GH_TOKEN ?? "",
    number,
  });
  await writeEligibilityOutput(decision, process.env);
  if (!decision.allowed) console.log(`Авторевью пропущено: ${decision.reason}`);
}

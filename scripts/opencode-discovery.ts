import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error("OpenCode discovery inspection failed");
  }
}

export async function assertSafeProject(directory: string): Promise<void> {
  // In 1.19.5 core plugin discovery ignores the V1 project-config/pure flags.
  if (await exists(join(directory, ".opencode")))
    throw new Error("OpenCode repository discovery directories are not supported in command runs");
  for (const name of ["opencode.json", "opencode.jsonc"]) {
    const path = join(directory, name);
    if (!(await exists(path))) continue;
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size > 1024 * 1024)
      throw new Error("OpenCode discovery configuration must be a small regular file");
    assertSafeConfig(await readFile(path, "utf8"));
  }
}

function assertSafeConfig(text: string) {
  try {
    // Deliberately reject unsupported JSONC instead of partially parsing away code.
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    for (const field of [
      "plugin",
      "plugins",
      "agent",
      "agents",
      "permission",
      "permissions",
      "experimental",
    ])
      if (Object.hasOwn(value, field)) throw new Error();
  } catch {
    throw new Error(
      "OpenCode discovery configuration is unsupported or contains runtime overrides",
    );
  }
}

export async function assertSafePullRequest(options: {
  repository: string;
  number: number;
  token: string;
  fetch?: typeof fetch;
}): Promise<void> {
  const { repository, number, token } = options;
  if (
    !/^[\w-]+\/[\w.-]+$/.test(repository) ||
    !Number.isSafeInteger(number) ||
    number <= 0 ||
    !token
  )
    throw new Error("OpenCode PR discovery inputs are invalid");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        const get = async (resource: string) => {
          const response = await (options.fetch ?? fetch)(
            `https://api.github.com/repos/${repository}/${resource}`,
            {
              headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
              },
              signal: controller.signal,
              redirect: "error",
            },
          );
          if (response.status !== 200) throw new Error();
          return await response.json();
        };
        const pr = await get(`pulls/${number}`);
        if (
          pr.head?.repo?.full_name?.toLowerCase() !== repository.toLowerCase() ||
          pr.base?.repo?.full_name?.toLowerCase() !== repository.toLowerCase() ||
          !Number.isSafeInteger(pr.head.repo.id) ||
          pr.head.repo.id <= 0 ||
          pr.head.repo.id !== pr.base.repo.id ||
          !/^[a-f0-9]{40}$/.test(pr.head.sha)
        )
          throw new Error();
        const tree = await get(`git/trees/${pr.head.sha}?recursive=1`);
        if (tree.truncated !== false || !Array.isArray(tree.tree)) throw new Error();
        for (const entry of tree.tree) {
          if (typeof entry.path !== "string" || typeof entry.type !== "string") throw new Error();
          if (entry.path.split("/").includes(".opencode")) throw new Error();
          if (!/(^|\/)opencode\.jsonc?$/.test(entry.path)) continue;
          if (entry.type !== "blob" || entry.mode !== "100644" || !/^[a-f0-9]{40}$/.test(entry.sha))
            throw new Error();
          const blob = await get(`git/blobs/${entry.sha}`);
          if (
            blob.encoding !== "base64" ||
            typeof blob.content !== "string" ||
            blob.content.length > 1_400_000
          )
            throw new Error();
          assertSafeConfig(Buffer.from(blob.content, "base64").toString("utf8"));
        }
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error()), 30000);
      }),
    ]);
  } catch {
    throw new Error("OpenCode PR discovery could not establish a safe internal source tree");
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

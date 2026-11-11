import { posix } from "node:path";

export type TreeEntry = { path: string; sha: string; size: number };
type RelatedFile = TreeEntry & { reason: string; content: string };
export type RepositoryContext = {
  baseSha: string;
  headSha: string;
  available: boolean;
  index: { base: TreeEntry[]; head: TreeEntry[] } | null;
  related: RelatedFile[];
  limitations: string[];
};

export const relatedFileLimit = 24;
export const relatedFileBytesLimit = 192 * 1024;
export const relatedBytesLimit = 320 * 1024;
const indexLimit = 5000;
const referenceScanLimit = 300;

export const safeRepositoryPath = (name: unknown): name is string =>
  typeof name === "string" &&
  name.length > 0 &&
  name.length <= 1000 &&
  !/[\x00-\x1f\x7f\\]/.test(name) &&
  !name.startsWith("/") &&
  !name.endsWith("/") &&
  name.split("/").every((part) => part && part !== "." && part !== "..");

const isTestPath = (path: string) => /(?:^|\/)[^/]+\.(?:test|spec)\.[^/]+$/i.test(path);
const codeExtensions = /\.(?:ts|tsx|mjs|cjs|js)$/i;

const importSpecifiers = (content: string | null) => {
  if (!content) return [];
  const found: string[] = [];
  for (const match of content.matchAll(
    /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)["']([^"'\r\n]{1,500})["']/g,
  ))
    found.push(match[1]);
  return found;
};

const moduleCandidates = (from: string, specifier: string) => {
  if (!specifier.startsWith(".")) return [];
  const joined = posix.normalize(posix.join(posix.dirname(from), specifier));
  if (joined === ".." || joined.startsWith("../")) return [];
  const candidates = [joined];
  if (/\.js$/i.test(joined))
    candidates.push(
      joined.replace(/\.js$/i, ".ts"),
      joined.replace(/\.js$/i, ".tsx"),
      joined.replace(/\.js$/i, ".mjs"),
    );
  for (const extension of [".ts", ".tsx", ".mjs", ".cjs", ".js", ".json", ".css", ".sql"])
    candidates.push(`${joined}${extension}`);
  for (const suffix of ["/index.ts", "/index.tsx", "/index.mjs", "/index.js"])
    candidates.push(`${joined}${suffix}`);
  return candidates;
};

const resolveRepositoryModule = (
  from: string,
  specifier: string,
  entries: Map<string, TreeEntry>,
) => moduleCandidates(from, specifier).find((candidate) => entries.has(candidate)) ?? null;

const indexTree = (entries: Map<string, TreeEntry>) => ({
  items: [...entries.values()].slice(0, indexLimit).map(({ path, sha, size }) => ({
    path,
    sha,
    size,
  })),
  truncated: entries.size > indexLimit,
});

/**
 * Select bounded unchanged related files from the pinned base and head trees.
 * The caller supplies API-only primitives; no PR code is imported or executed.
 */
export async function collectRepositoryContext(options: {
  baseSha: string;
  headSha: string;
  changes: { filename: string; baseSource: string | null; headSource: string | null }[];
  tree: (ref: string) => Promise<Map<string, TreeEntry>>;
  read: (path: string, maxBytes: number) => Promise<{ bytes: Uint8Array; decoded: string }>;
  essential: (...items: string[]) => void;
}): Promise<RepositoryContext> {
  const { baseSha, headSha, changes, essential } = options;
  const context: RepositoryContext = {
    baseSha,
    headSha,
    available: false,
    index: null,
    related: [],
    limitations: [],
  };
  const limitation = (message: string) => {
    if (!context.limitations.includes(message)) context.limitations.push(message);
  };
  let baseEntries: Map<string, TreeEntry> | null = null;
  let headEntries: Map<string, TreeEntry> | null = null;
  try {
    [baseEntries, headEntries] = await Promise.all([
      options.tree(options.baseSha),
      options.tree(options.headSha),
    ]);
    context.available = true;
  } catch {
    const message =
      "Контекст связанных файлов репозитория недоступен: деревья репозитория на закреплённых base и head не удалось загрузить, поэтому собраны только изменённые файлы, связанные материалы и базовые документы.";
    limitation(message);
    essential(message);
  }
  if (!baseEntries || !headEntries) return context;
  const baseIndex = indexTree(baseEntries);
  const headIndex = indexTree(headEntries);
  context.index = { base: baseIndex.items, head: headIndex.items };
  if (baseIndex.truncated || headIndex.truncated) {
    const message = `Индекс файлов репозитория превышает ${indexLimit} записей и был усечён; ревьюер не может перечислить все закреплённые файлы, хотя отбор связанных файлов использовал полное полученное дерево.`;
    limitation(message);
    essential(message);
  }
  const changed = new Set(changes.map((change) => change.filename));
  const related = new Map<string, { reason: string; priority: number }>();
  const addRelated = (path: string | null, reason: string, priority: number) => {
    if (!path || changed.has(path)) return;
    const existing = related.get(path);
    if (!existing || priority < existing.priority) related.set(path, { reason, priority });
  };
  const resolveRelatedModule = (from: string, specifier: string) =>
    resolveRepositoryModule(from, specifier, headEntries) ??
    resolveRepositoryModule(from, specifier, baseEntries);
  const byDirectory = new Map<string, string[]>();
  for (const path of headEntries.keys()) {
    const directory = posix.dirname(path);
    const siblings = byDirectory.get(directory);
    if (siblings) siblings.push(path);
    else byDirectory.set(directory, [path]);
  }
  for (const change of changes) {
    for (const content of [change.baseSource, change.headSource])
      for (const specifier of importSpecifiers(content))
        addRelated(
          resolveRelatedModule(change.filename, specifier),
          `Imported by changed file ${change.filename}.`,
          2,
        );
    const directory = posix.dirname(change.filename);
    const basename = posix.basename(change.filename);
    const stem = basename.replace(/\.[^.]+$/, "");
    const testSubject = /^(.+)\.(?:test|spec)\.[^/]+$/i.exec(basename)?.[1] ?? null;
    for (const path of [
      ...(byDirectory.get(directory) ?? []),
      ...(byDirectory.get(posix.join(directory, "__tests__")) ?? []),
    ]) {
      const name = posix.basename(path);
      if (isTestPath(path) && (name === basename || name.startsWith(`${stem}.`)))
        addRelated(path, `Test for changed file ${change.filename}.`, 0);
      else if (isTestPath(path))
        addRelated(path, `Test in the same directory as changed file ${change.filename}.`, 4);
      else addRelated(path, `Source in the same directory as changed file ${change.filename}.`, 6);
    }
    if (testSubject)
      addRelated(
        resolveRelatedModule(change.filename, `./${testSubject}`),
        `Subject of changed test file ${change.filename}.`,
        1,
      );
  }
  if (changes.some((change) => /^(?:apps\/api\/|contract\/|generated\/)/.test(change.filename)))
    for (const path of headEntries.keys())
      if (
        /^contract\/[^/]+\.tsp$/i.test(path) ||
        /^generated\/(?:openapi\/openapi\.yaml|sdk\/client\.ts)$/i.test(path) ||
        /^apps\/api\/src\/(?:.*\/)?contract[^/]*\.test\.ts$/i.test(path)
      )
        addRelated(path, "Contract chain for the changed API.", 5);
  // Locate unchanged importers of the changed files without executing any code.
  const areas = new Set<string>();
  for (const change of changes)
    for (const area of ["apps/web/src", "apps/api/src", "scripts", "e2e"])
      if (change.filename.startsWith(`${area}/`)) areas.add(area);
  let scanFailures = 0;
  if (areas.size) {
    const candidates = [...headEntries.values()]
      .filter(
        (entry) =>
          !changed.has(entry.path) &&
          codeExtensions.test(entry.path) &&
          entry.size <= 512 * 1024 &&
          [...areas].some((area) => entry.path.startsWith(`${area}/`)),
      )
      .sort((left, right) => left.path.localeCompare(right.path));
    const scan = candidates.slice(0, referenceScanLimit);
    if (candidates.length > scan.length) {
      const message = `Сканирование ссылок было ограничено ${scan.length} файлами репозитория при поиске неизменённого связанного кода.`;
      limitation(message);
      essential(message);
    }
    for (let index = 0; index < scan.length; index += 8) {
      await Promise.all(
        scan.slice(index, index + 8).map(async (entry) => {
          try {
            const { decoded } = await options.read(entry.path, 512 * 1024);
            for (const specifier of importSpecifiers(decoded)) {
              const target = resolveRelatedModule(entry.path, specifier);
              if (target && changed.has(target))
                addRelated(entry.path, `References changed file ${target}.`, 3);
            }
          } catch {
            scanFailures++;
          }
        }),
      );
    }
    if (scanFailures) {
      const message = `При сканировании ссылок не удалось прочитать ${scanFailures} файл(ов) репозитория для поиска неизменённого связанного кода.`;
      limitation(message);
      essential(message);
    }
  }
  const selected: RelatedFile[] = [];
  let relatedBytes = 0;
  let omitted = 0;
  const ordered = [...related.entries()].sort(
    ([leftPath, left], [rightPath, right]) =>
      left.priority - right.priority || leftPath.localeCompare(rightPath),
  );
  for (const [path, { reason }] of ordered) {
    const entry = headEntries.get(path);
    const baseEntry = baseEntries.get(path);
    if (!entry) continue;
    if (!baseEntry || baseEntry.sha !== entry.sha) {
      const message = `Связанный файл репозитория ${path} отличается между закреплёнными base и head, но не указан как изменённый; он не включён как неизменённый связанный контекст.`;
      limitation(message);
      essential(message);
      continue;
    }
    if (
      entry.size > relatedFileBytesLimit ||
      selected.length >= relatedFileLimit ||
      relatedBytes + entry.size > relatedBytesLimit
    ) {
      omitted++;
      continue;
    }
    try {
      const { bytes, decoded } = await options.read(path, relatedFileBytesLimit);
      if (bytes.length !== entry.size) throw new Error();
      selected.push({ path, sha: entry.sha, size: entry.size, reason, content: decoded });
      relatedBytes += bytes.length;
    } catch {
      const message = `Связанный файл репозитория ${path} не удалось загрузить на закреплённом head.`;
      limitation(message);
      essential(message);
    }
  }
  context.related = selected;
  if (omitted) {
    const message = `Контекст связанных файлов репозитория ограничен ${selected.length} неизменёнными файлами; ${omitted} связанных файлов исключены по лимиту количества или размера.`;
    limitation(message);
    essential(message);
  }
  const summary =
    "Контекст связанных файлов репозитория ограничен выбранными неизменёнными файлами на закреплённых base и head; полный репозиторий не копировался в рабочее пространство ревью.";
  limitation(summary);
  essential(summary);
  return context;
}

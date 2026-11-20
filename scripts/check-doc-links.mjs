import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function findMissingLinks(file, content) {
  const withoutCode = content
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[^\n]*$/gm, "")
    .replace(/`+[^`\n]*`+/g, "");
  const links =
    /!?\[[^\]\n]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+[^)]*)?\s*\)|^ {0,3}\[[^\]]+\]:\s*(?:<([^>]+)>|([^\s]+))/gm;
  const missing = [];
  for (const match of withoutCode.matchAll(links)) {
    const target = match.slice(1).find(Boolean);
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(target)) continue;
    const path = target.split(/[?#]/, 1)[0];
    if (!path) continue;
    let decoded;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      missing.push(target);
      continue;
    }
    if (!existsSync(resolve(dirname(file), decoded))) missing.push(target);
  }
  return missing;
}

function markdownFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  const files = [resolve(root, "README.md"), ...markdownFiles(resolve(root, "docs/agents"))];
  let count = 0;
  for (const file of files) {
    for (const target of findMissingLinks(file, readFileSync(file, "utf8"))) {
      console.error(`${file}: missing local link ${target}`);
      count++;
    }
  }
  console.log(`Checked local Markdown links in ${files.length} files; ${count} missing.`);
  if (count) process.exitCode = 1;
}

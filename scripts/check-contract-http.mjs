import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "@babel/parser";

function contractFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return contractFiles(path);
    return /(^|\.)contract\.test\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
  });
}

const files = process.argv.length > 2 ? process.argv.slice(2) : contractFiles("apps/api/src");
let failed = false;
for (const file of files) {
  const source = parse(readFileSync(file, "utf8"), {
    sourceType: "module",
    plugins: ["typescript", "jsx"],
  });
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (node.type === "CallExpression" && node.callee.type === "MemberExpression") {
      const property = node.callee.property;
      if (
        (!node.callee.computed && property.name === "inject") ||
        (node.callee.computed && property.value === "inject")
      ) {
        console.error(
          `${file}:${node.loc.start.line}: contract tests must use real HTTP, not inject()`,
        );
        failed = true;
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object" && typeof value.type === "string") visit(value);
    }
  }
  visit(source.program);
}
if (failed) process.exitCode = 1;

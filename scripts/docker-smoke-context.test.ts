import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createContext, readApprovals } from "./docker-smoke-context.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "smoke-source-"));
  const context = mkdtempSync(join(tmpdir(), "smoke-context-"));
  execFileSync("git", ["init", "-q", root]);
  mkdirSync(join(root, "apps/web/public"), { recursive: true });
  writeFileSync(join(root, ".dockerignore"), ".git\n**/dist\n.env\n");
  writeFileSync(join(root, "Dockerfile"), "FROM scratch\n");
  writeFileSync(join(root, "apps/web/public/tracked.txt"), "old");
  execFileSync("git", ["add", "."], { cwd: root });
  return {
    root,
    context,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(context, { recursive: true, force: true });
    },
  };
}

it("copies modified tracked files and explicitly approved untracked binary inputs", () => {
  const { root, context, cleanup } = fixture();
  try {
    writeFileSync(join(root, "apps/web/public/tracked.txt"), "dirty");
    writeFileSync(join(root, "apps/web/public/logo.png"), Buffer.from([0, 1, 2]));
    createContext(root, context, ["apps/web/public/logo.png"]);
    expect(readFileSync(join(context, "apps/web/public/tracked.txt"), "utf8")).toBe("dirty");
    expect(readFileSync(join(context, "apps/web/public/logo.png"))).toEqual(Buffer.from([0, 1, 2]));
  } finally {
    cleanup();
  }
});

it("blocks unapproved and ignored local inputs without copying their contents", () => {
  const { root, context, cleanup } = fixture();
  try {
    writeFileSync(join(root, ".gitignore"), "apps/web/public/private.json\n");
    execFileSync("git", ["add", ".gitignore"], { cwd: root });
    writeFileSync(join(root, "apps/web/public/private.json"), "not-for-output");
    expect(() => createContext(root, context)).toThrow(/unapproved/i);
    expect(existsSync(join(context, "apps/web/public/private.json"))).toBe(false);
  } finally {
    cleanup();
  }
});

it("does not block or read files excluded by the actual dockerignore", () => {
  const { root, context, cleanup } = fixture();
  try {
    mkdirSync(join(root, "apps/web/dist"), { recursive: true });
    writeFileSync(join(root, "apps/web/dist/secret.json"), "not-for-output");
    writeFileSync(join(root, ".env"), "not-for-output");
    createContext(root, context);
    expect(existsSync(join(context, "apps/web/dist/secret.json"))).toBe(false);
    expect(existsSync(join(context, ".env"))).toBe(false);
    expect(readFileSync(join(context, ".dockerignore"), "utf8")).toBe(".git\n**/dist\n.env\n");
  } finally {
    cleanup();
  }
});

it("blocks unapproved credential-like files without inspecting their contents", () => {
  const { root, context, cleanup } = fixture();
  try {
    writeFileSync(join(root, "apps/web/public/service-account.json"), "not-for-output");
    expect(() => createContext(root, context)).toThrow(/unapproved/i);
    expect(existsSync(join(context, "apps/web/public/service-account.json"))).toBe(false);
  } finally {
    cleanup();
  }
});

it("copies a tracked file even when Git ignores it, unless Docker ignores it", () => {
  const { root, context, cleanup } = fixture();
  try {
    writeFileSync(join(root, ".gitignore"), "apps/web/public/tracked.txt\n");
    execFileSync("git", ["add", ".gitignore"], { cwd: root });
    writeFileSync(join(root, "apps/web/public/tracked.txt"), "dirty");
    createContext(root, context);
    expect(readFileSync(join(context, "apps/web/public/tracked.txt"), "utf8")).toBe("dirty");
  } finally {
    cleanup();
  }
});

it("refuses unsupported dockerignore syntax instead of silently dropping files", () => {
  const { root, context, cleanup } = fixture();
  try {
    writeFileSync(join(root, ".dockerignore"), ".git\n*.json\n!important.json\n");
    expect(() => createContext(root, context)).toThrow(/Unsupported .dockerignore/);
  } finally {
    cleanup();
  }
});

it("refuses a Dockerfile-specific ignore file whose precedence is not supported", () => {
  const { root, context, cleanup } = fixture();
  try {
    writeFileSync(join(root, "Dockerfile.dockerignore"), "*\n");
    expect(() => createContext(root, context, ["Dockerfile.dockerignore"])).toThrow(
      /Dockerfile.dockerignore/,
    );
  } finally {
    cleanup();
  }
});

it("does not silently ignore a file whose name ends with a newline", () => {
  const { root, context, cleanup } = fixture();
  try {
    writeFileSync(join(root, "fly.toml\n"), "not-for-output");
    // A literal dockerignore entry `fly.toml` must not match this distinct file.
    writeFileSync(join(root, ".dockerignore"), ".git\nfly.toml\n");
    expect(() => createContext(root, context)).toThrow(/unapproved/i);
    expect(existsSync(join(context, "fly.toml\n"))).toBe(false);
  } finally {
    cleanup();
  }
});

it("rejects symlinked directories and symlinked inputs without following them", () => {
  const { root, context, cleanup } = fixture();
  const outside = mkdtempSync(join(tmpdir(), "smoke-outside-"));
  try {
    writeFileSync(join(outside, "outside.txt"), "not-for-output");
    symlinkSync(outside, join(root, "apps/web/outside-link"), "dir");
    symlinkSync(join(outside, "outside.txt"), join(root, "apps/web/public/file-link.txt"));
    expect(() =>
      createContext(root, context, [
        "apps/web/outside-link/outside.txt",
        "apps/web/public/file-link.txt",
      ]),
    ).toThrow(/non-regular|symlink/i);
    expect(existsSync(join(context, "apps/web/public/file-link.txt"))).toBe(false);
  } finally {
    cleanup();
    rmSync(outside, { recursive: true, force: true });
  }
});

it("only reads an explicit approval list outside the checkout", () => {
  const { root, cleanup } = fixture();
  const external = mkdtempSync(join(tmpdir(), "smoke-approvals-"));
  try {
    const path = join(external, "approved.json");
    writeFileSync(path, JSON.stringify(["apps/web/public/logo.png"]));
    expect(readApprovals(root, path)).toEqual(["apps/web/public/logo.png"]);
    const inside = join(root, "..sensitive-list");
    writeFileSync(inside, "[]");
    expect(() => readApprovals(root, inside)).toThrow(/outside the checkout/);
    writeFileSync(path, JSON.stringify(["../secret"]));
    expect(() => readApprovals(root, path)).toThrow(/exact relative file paths/);
  } finally {
    cleanup();
    rmSync(external, { recursive: true, force: true });
  }
});

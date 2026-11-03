import type { onRouteHookHandler } from "fastify";

const methods = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);
const isApiPath = (path: string) => path === "/api" || path.startsWith("/api/");

export function collectRoutes() {
  const entries: string[] = [];
  const onRoute: onRouteHookHandler = (route) => {
    if (!isApiPath(route.url)) return;
    if (/\*|\?|\(|\)|::/.test(route.url)) {
      throw new Error(`Unsupported Fastify route pattern: ${route.url}`);
    }
    const path = route.url.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
    for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
      entries.push(`${method.toUpperCase()} ${path}`);
    }
  };
  return { entries, onRoute };
}

type Contract = { paths: Record<string, Record<string, unknown>> };

export function compareRoutes(actual: string[], contract: Contract) {
  const documented = Object.entries(contract.paths).flatMap(([path, pathItem]) => {
    if (!isApiPath(path)) return [];
    return Object.keys(pathItem)
      .filter((method) => methods.has(method.toLowerCase()))
      .map((method) => `${method.toUpperCase()} ${path}`);
  });
  const actualSet = new Set(actual);
  const documentedSet = new Set(documented);
  return {
    undocumented: [...actualSet].filter((route) => !documentedSet.has(route)).sort(),
    unimplemented: [...documentedSet].filter((route) => !actualSet.has(route)).sort(),
  };
}

# Knip quality gate

Run the full development-and-production scan with `mise run lint:unused`.
For machine-readable results, use `mise run lint:unused -- --reporter json`.
Findings fail the command. There is no baseline, automatic fix, globally excluded
rule, or ignored source file. The narrow, approved integration exceptions below
are explicit in `knip.json`.

## Project model

- The root and both `apps/*` packages are distinct workspaces. Broad source
  globs include scripts, tests, E2E helpers, configuration, and generated SDK
  source, rather than making every source file an entrypoint.
- Package scripts, GitHub Actions, and mise tasks supply CLI entrypoints through
  Knip's built-in plugins. Vitest discovers unit tests; Playwright discovers
  E2E specs and follows their fixture imports.
- `scripts/dev-target.mjs` is an explicit entrypoint because the mise daemon
  command invokes it inside a template-containing shell command that Knip skips.
- The API starts at `src/server.ts`, discovered from package scripts. Its explicit entrypoint,
  `test-support/booking-worker.ts`, is launched with `fork()` by booking and
  meeting-type concurrency tests, not imported as a module. Drizzle's plugin
  discovers its configuration and schema.
- Vite discovers the web entrypoint from `index.html`; its configuration also
  reaches build-info code. Application and test imports reach the SDK.
- Orval's configuration lives at `contract/orval.config.ts`, not the plugin's
  default root location. Configuring its real location makes it discoverable.
  The generated SDK is **not** declared an entrypoint to conceal unused exports.
- Knip 6.44.1 has no TypeSpec plugin. Imports in `contract/main.tsp` and the
  emitter in `tspconfig.yaml` are therefore outside its dependency graph. The two
  resulting false positives are handled by exact dependency names below.

## Compatibility

Verified on the repository's Node 24.22.2 and TypeScript 7.0.2 installation with
Knip 6.44.1. The full scan completes successfully after the approved integration
exceptions and unused-export cleanup, without a parser, resolver, or TypeScript
API crash. Knip uses `oxc-parser` and `oxc-resolver`
rather than a runtime TypeScript compiler dependency; its own package also lists
TypeScript 7.0.2 as a development dependency. This verifies this project's
current syntax/configuration, not every possible TypeScript 7 feature.

## Initial findings for issue #49

Before applying the approved exceptions and cleanup, the full scan after
registering the focused quality-gate tasks reported:

- `binaries`: **9**. Root manifest: `jactionlint`, `shellcheck`, `hadolint`,
  `osv-scanner`; `scripts/dev-start.mjs`: `mise`, `pitchfork`;
  `scripts/dev-target.mjs`: `mise`; `scripts/dev-url.mjs`: `mise`, `pitchfork`.
- `devDependencies`: **2**. Root manifest: `@typespec/http`, `@typespec/openapi3`.
- `exports`: **13**. Twelve generated SDK exports, plus `plural` in
  `apps/web/src/pages/book/format.ts:81`.
- `types`: **71**. `generated/sdk/client.ts` only.
- All other reported rules: **0**. No unused files, unused production
  dependencies, unresolved imports, unlisted dependencies, duplicate exports,
  enum members, namespace members, catalog issues, or optional-peer issues.

Total: **95 findings**, counting repeated binary references separately.
Counts are a discovery snapshot, not an accepted baseline or skip list.

The 12 generated value exports are `getCreateBookingUrl`,
`getUpcomingEventsUrl`, `getHealthUrl`, `health`, `getMeetingTypesListUrl`,
`getMeetingTypesCreateUrl`, `getMeetingTypeResourceReadUrl`,
`meetingTypeResourceRead`, `getMeetingTypeResourceUpdateUrl`,
`getMeetingTypeResourceRemoveUrl`, `getAvailabilitySummaryUrl`, and
`getAvailabilitySlotsUrl`. Generated type findings include models and the
per-operation response aliases; the JSON report enumerates all 71 by name and
source position.

## Approved integration exceptions and cleanup

The user approved these non-security configuration exceptions for issue #49;
they do not require expiry dates.

1. Root-workspace `ignoreBinaries` names only `mise`, `hk`, `pitchfork`, `jactionlint`,
   `shellcheck`, `hadolint`, and `osv-scanner`. `mise` is the required environment
   manager; the other binaries are pinned in `mise.toml`, not npm dependencies.
   This models their external installation, without disabling binary checks for
   any other command.
2. Root-workspace `ignoreDependencies` names only `@typespec/http` and
   `@typespec/openapi3`. Both are imported in `contract/main.tsp`; the latter is
   also the emitter in `tspconfig.yaml`. They are required but not understood by
   Knip's current plugins. All other dependencies remain checked.
3. `ignoreIssues` allows only unused `exports` and `types` in the exact file
   `generated/sdk/client.ts`. Orval emits the full contract surface, including
   operations and aliases not consumed by the current UI. Removing those by
   hand would violate generator ownership. The file remains in the graph, so
   its imports and other issue categories are still analyzed; no generated
   directory or whole file is ignored.
4. Removed only the unused export modifier from `plural`. The function is still
   required privately by `formatMinutes` and `formatSlotCount`; its behavior is
   unchanged.

With these changes the full gate passes with no remaining findings. There is no
baseline or blanket exclusion, and no unrelated dead code was removed.
There is no custom analysis logic requiring bespoke unit tests.

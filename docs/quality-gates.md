# Quality gates

Adoption of [Dev Quality Gates](https://github.com/mokevnin/dev-quality-gates), following its [adoption guide](https://github.com/mokevnin/dev-quality-gates/blob/main/docs/adopt.md). Approved scope and exception decisions: [#49](https://github.com/ignateff/ai-for-developers-project-387/issues/49).

## Running the gates

Install with `mise install && mise run install`. Install shared hooks separately with `mise run install-hooks`. CI and developers use the same pinned mise tools and locked npm development tools.

- **Complete:** `mise run check`. Requires Chromium, Docker and network access to vulnerability data. A skipped or unavailable check is not a pass.
- **Pre-push:** `mise run check:push` runs whole-project offline checks.
- **Security:** `mise run check:security` scans current sources and reachable Git history, workflows and the pnpm lockfile, and validates risk-exception deadlines. CI runs it daily as well as including it in the complete gate.
- **Fast:** `mise run check:files` runs shared hk file checks across the repository. The pre-commit hook selects staged paths instead; staged secrets come from the index, not unstaged content.

Hooks are conveniences, not merge authorization. CI's `check` job is the merge gate. Configure branch protection to require it; repository files alone cannot enable that setting. The daily `security` job evaluates newly published advisories and calendar expiry even without code changes.

## Scope and limits

Existing Oxlint (`--deny-warnings`), oxfmt, TypeScript, tests, browser/visual tests, contract checks, generated-artifact verification and Docker smoke checks are retained. Existing TypeScript strictness and formatting conventions are unchanged. All workflows are now linted, including the protected generated Hexlet workflow.

New tools are Knip, Betterleaks, OSV-Scanner, commitlint and Hadolint. Upstream release and maintenance metadata were checked on 2026-11-06. Knip's GitHub release 6.44.2 was not published on npm; 6.44.1 is pinned instead. Hadolint is GPL-3.0, explicitly approved for use as a checker; no licence allowlist policy is introduced.

Betterleaks uses pinned built-in rules with explicit configuration and redacted diagnostics. It does not validate credentials against providers. Files selected by Git include tracked files even when ignored, plus eligible untracked files; ignored untracked local secrets and dependencies are outside source scanning. Symlinks are not followed outside the checkout. Detection is heuristic, not proof that no secret exists.

OSV scans all packages in `pnpm-lock.yaml`, including development/transitive dependencies. Network errors, missing input, malformed reports and incomplete scans fail. It does not scan OS packages inside the Docker image. The scoped Scalar/undici override remediates a vulnerable exact transitive pin; remove it once the parent dependency supplies a patched version. The existing Fastify static plugin was updated within its major version to obtain patched glob/minimatch.

Commitlint enforces the existing Conventional Commits format, not new header/body length or subject-case standards. CI validates the PR's commit range or the pushed range; local runs compare against `origin/main`. Merge commits retain commitlint's default exemptions. Historical commits are not retroactively reformatted. Message accuracy and English prose remain human review concerns.

## Findings and exceptions

Initial full-scope scans found:

| Check                            | Findings before adoption                                               |
| -------------------------------- | ---------------------------------------------------------------------- |
| Knip                             | 95: 9 binary references, 2 TypeSpec dependencies, 13 exports, 71 types |
| Betterleaks history              | 105: 90 generic-password, 12 generic-credential-uri, 3 generic-api-key |
| Betterleaks current files        | 35                                                                     |
| OSV                              | 32 advisories across esbuild, glob, minimatch and undici               |
| jactionlint                      | 1 new finding in the protected Hexlet workflow                         |
| Hadolint / standalone ShellCheck | 0                                                                      |

The unused handwritten `plural` export became private; runtime behavior is unchanged. The remaining [Knip configuration](quality-gates-knip.md) models external tools/TypeSpec and ignores only unused exports/types in the exact generated SDK file. Never delete generated exports by hand.

Dependency remediation resolved 31 OSV advisories. The owner accepted only `GHSA-67mh-4wv8-2f99` for npm `esbuild@0.18.20` in `pnpm-lock.yaml`, retained by Drizzle Kit's deprecated loader. This repository does not invoke esbuild's affected development-server API; the package is still vulnerable. This is risk acceptance, not a fix.

The owner also accepted exact existing secrets findings (including **unverified design-file matches**) and the Hexlet checkout `artipacked` finding. The protected workflow is unchanged. These risk exceptions require review by **2026-12-06**; checks fail after that date. Reasons and scopes live under `config/quality-gates/`. New advisories, different package versions, changed accepted source content and unmatched findings remain blocking.

The secrets baseline contains **175 identities**: 105 entries from the initial history scan, 35 additional merge-diff occurrences of existing accepted source findings found by the exhaustive `--full-history -m` scan, and 35 current-snapshot entries. History identities include the immutable commit; snapshot identities include the whole Git blob. See [secrets baseline](quality-gates-secrets.md) for the inventory and maintenance rules.

Renewal requires a new human decision with evidence and a new deadline. Do not auto-regenerate baselines or widen ignores to get a change through. Tests cover date format, real calendar dates and overdue reviews. Existing workflow inline suppressions predate this adoption and retain their documented rationale; this change does not expand them.

## Deliberately not installed

- Renovate: not approved; dependency-update automation remains a follow-up, not an enforced gate.
- dependency-cruiser/syncpack: deferred architecture and dependency-range policy decisions.
- check-jsonschema: considered, but no concrete schema gap chosen beyond existing validators/workflow lint.
- Stylelint/axe-core/size-limit/diff-cover: separate CSS, accessibility, performance-budget and coverage decisions.
- vacuum/oasdiff: retain contract checks; defer additional API style and compatibility policy.
- agnix/documentation linters: avoid broad changes to preserved third-party skills and existing prose.
- Other language, Terraform, Kubernetes and PostgreSQL tools: not applicable to this stack.

The catalogue has no recommendation for container-image scanning, image-layer efficiency, IaC security, YAML style or licence/supply-chain compliance. Nothing from its **Under review** or **not-adopted** lists was installed. Research notes can disagree with the curated recommendations; the Recommendations list controls selection.

## Verification

`scripts/quality-gates.test.ts` exercises real secret, commit-message, workflow, Dockerfile and shell violations in disposable repositories on scratch branches, plus scanner error handling and exception expiry. Synthetic tokens never receive live validation. Additional adoption evidence and aggregate/CI results are recorded in the PR for #49.

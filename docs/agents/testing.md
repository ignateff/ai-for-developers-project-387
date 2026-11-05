# Testing

`mise run check` runs lint, formatting, types, Vitest, Playwright, contract and generated-artifact checks, build, and workflow lint. CI runs the same check after installing Chromium.

The full check also runs `mise run test:docker-smoke`: Docker and its daemon are required, and an unavailable daemon is an error. It builds the current working-copy production inputs for `linux/amd64` (potentially slow under Apple Silicon emulation), then starts the normal image command on `PORT=8080` with an isolated in-memory database and an automatically assigned loopback port. Health, the page, JavaScript assets, browser errors and the exact production version message are checked. Only resources created by the run are removed; no deployment or booking is performed. The displayed revision is a random smoke marker, not a Git commit or a claim that a dirty checkout matches `HEAD`.

The smoke build context follows an explicit trust policy: tracked files (including modified ones) are trusted, and their contents are not scanned; untracked files not excluded by `.dockerignore` require exact-path approval through an external `CALENDAR_SMOKE_ALLOWLIST` JSON file, and ambiguous inputs block the check instead of being silently included or dropped. Trusting a file does not verify that its contents are free of secrets.

If a `docker build`/`create` answer is lost (timeout or signal), the daemon may still finish it after the client stopped waiting. The run reconciles owned resources within a bounded budget and removes only resources carrying the run's ownership label. If completion still cannot be proven, the run fails with an `unresolved` outcome, writes a secret-free recovery record under `~/.local/state/calendar-smoke-recoveries/` and prints the `node scripts/docker-smoke.ts recover <record>` command; recovery re-verifies name and ownership label before deleting. Absence in one inspection is not proof that the daemon will not create the resource later.

Recovery also fails with `unresolved` and retains its record when inspection fails or a resource is still absent. It does not equate an unavailable daemon with completed cleanup. Each acknowledged removal is atomically recorded before moving on, so a later attempt only processes remaining resources. An empty resource list is a receipt that all removals were acknowledged; recovery can finish clearing that record after an interruption. An absent resource with unknown completion requires further investigation, not automatic deletion of the recovery record.

The smoke trusts all tracked files, including local modifications; it does **not** inspect them for secrets. New untracked or Git-ignored inputs which are not excluded by `.dockerignore` stop the check before their contents are read. To approve individual files, the owner can create a JSON array of exact checkout-relative paths in a file **outside the checkout**, and set `CALENDAR_SMOKE_ALLOWLIST` to its absolute path. No list is generated or modified automatically. Approved files are trusted too; review them before approval. Empty directories require their own explicit approval. The smoke applies the existing `.dockerignore` and fails closed on rules it cannot interpret, rather than silently omitting inputs. CI needs no approval list for a clean checkout. This local check does not replace the stricter deploy gate or its immutable context.

Containers and images have unique run-specific names and ownership labels. Cleanup verifies the labels before removal. If a Docker command is interrupted or its result is uncertain, the check reports its run-specific names and label: inspect them for late completion rather than assuming the daemon stopped the operation. Never remove a resource whose ownership cannot be verified.

Local pre-commit and pre-push hooks run `mise run check:quick` (lint, formatting and types), without starting dev daemons. This is not a replacement for the full CI check; require a successful `check` status before merging. Run `mise run check` explicitly for full local validation.

## Deployment verification

`mise run test -- scripts/deploy-fly.test.ts` exercises the deployment CLI through substitute Git/Fly/Docker executables and a local HTTP/browser fixture, without production credentials. Browser-backed scenarios use a real Chromium instance and many short-lived substitute CLI processes, so they set an explicit 35-second per-test deadline. The spawned `deploy-fly.mjs` process is killed at 30 seconds, deliberately before the test deadline, so a hang fails with captured stdout/stderr and still runs `finally` cleanup. The global Vitest timeout and production command budgets are unchanged; see [Vitest testTimeout](https://vitest.dev/config/testtimeout). The verification currently accepts only Machines observed as `started`, with confirmed checks, digest and release identity. It cannot establish an unambiguous autostop cause from the [public Machine/event schema](https://github.com/superfly/fly-go/blob/7b20a9b258873893c273712f4dc8fcf627c95878/machine_types.go): configured autostop and a requested stop do not prove why the Machine stopped. Thus even a genuinely idle `stopped` Machine fails verification and needs separate investigation; no automatic start, restart or deployment retry is added. This conservative limitation is preferable to reporting a crash or unknown stop as successful deployment. See [Fly Proxy autostop/autostart](https://fly.io/docs/reference/fly-proxy-autostop-autostart/) for the distinction between configuration and observed state.

## Development lifecycle tests

`mise run test -- scripts/dev.test.ts` checks real `mise run dev` behavior in temporary checkouts. The suite uses its own Pitchfork supervisor, registry, logs and mise state, shared between its checkouts to exercise independent routing and shutdown. It leaves user daemon state unchanged. A short temporary directory under the home directory keeps the Unix socket within macOS path limits. TCP ports remain shared with the host and use the application's port allocation.

Subprocesses are awaited asynchronously with bounded command timeouts and captured output. On startup failure, the error includes daemon state and the isolated log directory. Cleanup tries every owned checkout and verifies terminal state with no PID before deleting it (an intentionally failed daemon can remain `errored`). Failed cleanup preserves the affected checkout and state for inspection. Filtered test runs create only the checkouts they use. The suite does not clear or prune global daemon state.

## API

`apps/api/src/contract.test.ts` validates real HTTP responses against OpenAPI. Add a contract test for each response scenario of every new operation, including distinct error scenarios sharing a status code. Tests named `contract.test.ts` or `*.contract.test.ts` must use real HTTP; `mise run check:contract-http` rejects `inject()` calls in those files. Reviewers must still check scenario coverage and test semantics. Other test files may use Fastify injection where real HTTP is not required by the specification.

The HTTP guardrail is a syntactic check, not proof that a test uses real HTTP: it does not follow calls into helpers or detect an `inject` method called through an alias. Reviewers must check these cases too.

Integration tests use SQLite and controlled clocks and failures where the behavior requires them. For booking retries, exercise failures both before the request reaches the server and after persistence but before the response reaches the client.

## Web and end-to-end

`apps/web` uses Vitest, jsdom and Testing Library for user-visible states and interactions. Tests requiring Mantine's `matchMedia` stub provide one in setup. `e2e/` uses Playwright and Chromium for the main booking, recovery, management and event-list flows.

Frontend API requests must use the generated SDK. `.oxlintrc.json` applies a network-boundary rule to all production JavaScript/TypeScript in `apps/web/src`: no direct `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` (including access through `window`, `globalThis` and `self`), `sendBeacon`, or imports of the listed alternative HTTP clients. It is part of the existing `mise run lint`, `check:quick` and `check` commands, independently of generated-artifact freshness and real HTTP contract tests. Frontend `*.test.*` / `*.spec.*` files remain linted but are exempt from this restriction; server code and the generated SDK are outside its scope.

`scripts/sdk-boundary.test.ts` checks the actual Oxlint configuration against allowed and rejected fixtures, without enumerating individual API operations. This is a syntactic architecture guardrail, not proof that every SDK operation executes or protection against every deliberate bypass: dynamically computed access, indirect aliases/helpers and unlisted networking dependencies may escape it. New legitimate frontend network access outside the API requires an explicit boundary/configuration decision, not an inline lint suppression.

Playwright starts a dedicated in-memory API and web server and runs test files with one worker because they share that database. For concurrent worktrees, give each run a distinct pair of free ports, for example:

```sh
E2E_API_PORT=3320 E2E_WEB_PORT=5320 mise run test:e2e
```

These settings affect Playwright's servers only; they are not configuration for the regular `mise run dev` daemons. Install the browser with `mise run test:e2e:install` when needed.

Elements whose visible text is localized or formatted (dates, counts, times) get a stable `aria-label` carrying the machine value (e.g. an ISO date on calendar day buttons), and e2e selectors target role plus that stable name rather than the rendered text. When changing visible UI text, grep `e2e/` and `*.test.*` for the old string first.

When a test switches between dialogs, wait for the previous dialog to close and scope actions to the active dialog. This avoids interacting with a closing dialog during its transition.

## Visual verification

For UI work with a design reference, use the workflow in `docs/design/README.md`. Functional tests do not establish visual fidelity. Add or update visual regression tests for stable, representative screens and states when an approved design-matching baseline is available; capture deterministic viewport, data, time, fonts and browser. Review baseline changes against the design before accepting them. Do not approve the current UI as the baseline merely because a screenshot test passes.

Use representative data that exercises the layout, including multiple items where they affect columns or spacing. Record separately which viewport sizes were compared with a design reference and which were only checked for regressions; report missing reference sizes as a limitation.

`e2e/00-visual.spec.ts` holds the approved baselines for the screens in `docs/design/calendar-booking.pen` (desktop 1400×900 and narrow 390×844). Determinism comes from the shared `e2e/fixed-now.ts` clock (2026-03-27T08:00:00Z, as in the design) and the bundled Inter font. `playwright.config.ts` passes this time to the API via `CALENDAR_FIXED_NOW`; all e2e specs import `test` from `e2e/fixtures.ts`, which fixes browser `Date` before navigation without freezing timers. The `00-` prefix matters: the file must run first because baselines assume a pristine in-memory database. Playwright keeps baselines per platform (`-darwin`, `-linux`); regenerate them with `mise run test:e2e:visual:update` for the current platform and `mise run test:e2e:visual:update:linux` for CI (requires Docker). Review every baseline against the `.pen` frames before committing. The shared copyright footer is an approved addition in project #6, absent from the design frames; it must be the only visual change for that task.

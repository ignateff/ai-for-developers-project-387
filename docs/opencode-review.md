# Local review adapter

`scripts/opencode-review.ts` exports `reviewSnapshot`. It accepts a path to the
checksum- and version-verified OpenCode runtime, a prepared `ReviewContext`, an
optional DeepSeek API key, and an optional `AbortSignal`. It
returns structured findings or rejects; failures are not reviews. Install the
pinned runtime with `mise run opencode:install -- <directory>`.

The caller must prepare the snapshot from trusted base tooling. Include the
requirements and agreement (or mark them unavailable), base and head SHA,
changes, CI results, and previous review. A release PR need not have an
invented feature specification. The adapter does not fetch or verify these
inputs, publish a review, or implement GitHub integration.

Run the adapter itself from a trusted base revision, not from the PR under
review. It creates a fresh private workspace and treats the snapshot as data;
it does not check out or execute the PR. It strips ambient GitHub credentials,
uses a read-only, default-deny policy and validates the resolved agent before
starting a fresh noninteractive CLI session. The snapshot is split into bounded
JSONL fragments and a review is rejected unless the runtime reports reading
every fragment in full. OpenCode tool permissions are not an
OS sandbox: this isolation does not defend against a compromised runtime or a
hostile local user with access to the process. Avoid secrets in snapshots.

`mise run test:opencode-review-runtime` is intended to exercise the pinned CLI
with a local fixture provider, without real model calls or credentials. Passing
local tests does not demonstrate GitHub publishing.

# Upstream OpenCode comparison (#90) — concluded

The temporary comparison with the upstream OpenCode GitHub Action is over. Its
comment triggers for `/oc` and `/opencode` were moved to the normal
`.github/workflows/opencode.yml` workflow, the manual `workflow_dispatch` entry
point was removed from that workflow, and the experiment workflow was deleted in
the same change. Automatic PR review and issue triage were not touched.
`scripts/opencode-workflow.test.ts` asserts that only `opencode.yml` subscribes to
`issue_comment`/`pull_request_review_comment`, so exactly one `/oc` handler
remains.

## What the experiment showed

The upstream Action pinned its source commit but installed the latest OpenCode CLI
through its own install script, so the effective runtime was not pinned by this
project. It used OpenCode defaults rather than the validated command policy and
did not enforce the command attempt budget or the output allowlist. Its raw logs
also demonstrated the risk in the #83 work: they contained full shell commands
(including `env`/`cat` probes), prompts, model text and runtime internals, and one
run hung waiting for an `external_directory` permission until the job timeout.
GitHub masking does not guarantee removal of encoded or unregistered secrets, and
the repository is public.

## What replaced it

The normal workflow keeps the original trust preflight, the pinned and verified
runtime, the validated tool/skill/subagent policy, the attempt budget and the
failure reporting. It now also has two-hour nested limits and a safe activity log
(allowlisted stages, tool names and decisions, redacted command families, subagent
start/end and permission waits; never prompts, file contents, full commands, tool
output or tokens). Check results and tool output remain unavailable through that
safe channel; `docs/opencode-commands.md` records the compromise and the options
that require a human decision.

The raw experiment workflow is preserved in Git history (PR #91). Restoring it for
raw diagnostics would need an explicit human decision, a temporary replacement of
the comment triggers, and a change that disables the normal handler while it runs.

## Verification

Static checks and CI cover the restored triggers, the single-handler invariant and
the two-hour timeout configuration. A controlled run on a trusted test issue after
merge must confirm that exactly one handler starts, the activity log and digest
are present, a cancellation or timeout leaves no child processes and the failure
report states that task completion is not confirmed. Until that run is recorded,
those live criteria remain unverified.

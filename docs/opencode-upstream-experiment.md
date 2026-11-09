# Temporary upstream OpenCode comparison (#90)

The usual command workflow's comment triggers are disabled while the separate
`opencode-upstream-experiment.yml` workflow handles `/oc` and `/opencode`.
The experiment retains the existing original-author and same-repository PR trust
preflight. Issue triage and independent PR review remain separate.

The upstream Action is pinned to its source commit, but its composite action
installs the latest OpenCode CLI using an upstream install script. The effective
runtime and nested actions are therefore not pinned by our project. This is a
controlled temporary experiment, not evidence that runtime provenance matches
our verified 1.19.5 binary.

Unlike the normal command adapter, the upstream Action uses OpenCode defaults
and project configuration, not the project's validated command tool and skill
policy. It does not enforce the command attempt budget or our output allowlist.
It exchanges the Actions OIDC token for an OpenCode GitHub App token, whose
permissions are separate from the job's `GITHUB_TOKEN`. Its raw output may
contain model requests, file contents, commands, or dynamically obtained tokens;
GitHub masking cannot guarantee removal of encoded or unregistered secrets.
Inspect the run before sharing logs. The 20-minute job timeout is not a monetary
ceiling. Do not use the experiment for untrusted code or confidential tasks.

The normal handler now also has prepared two-hour limits and a detailed safe
activity log (allowlisted stages, tool names, redacted command families,
subagent start/end and permission waits; never prompts, file contents, full
commands, tool output or tokens). Those changes do not enable it: the comment
triggers stay disabled and this experiment remains the only `/oc` handler.

To restore the normal workflow, replace `workflow_dispatch` in
`.github/workflows/opencode.yml` with `issue_comment` and
`pull_request_review_comment` events for `created`, and remove or disable this
experimental workflow in the same change. Run `mise run check`, then verify on
a trusted test issue that exactly one command handler starts and that the live
activity log and post-run digest are present. Until that restoration merges,
`/oc` runs through the experiment.

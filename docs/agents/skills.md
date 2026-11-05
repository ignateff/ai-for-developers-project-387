# Project skill configuration

Project-local skills are preserved unchanged in [`.agents/skills/`](../../.agents/skills/) so agents can discover them. This document records their configuration; each skill's `SKILL.md` owns its invocation rules and instructions.

| Skill                     | Entry point                                                         | Origin                                         |
| ------------------------- | ------------------------------------------------------------------- | ---------------------------------------------- |
| Fastify best practices    | [SKILL.md](../../.agents/skills/fastify-best-practices/SKILL.md)    | `mcollina/skills`                              |
| Mantine form              | [SKILL.md](../../.agents/skills/mantine-form/SKILL.md)              | `mantinedev/skills`                            |
| Playwright best practices | [SKILL.md](../../.agents/skills/playwright-best-practices/SKILL.md) | `currents-dev/playwright-best-practices-skill` |
| Fly deployment            | [SKILL.md](../../.agents/skills/fly-deploy/SKILL.md)                | First-project maintained skill                 |
| Git worktrees             | [SKILL.md](../../.agents/skills/using-git-worktrees/SKILL.md)       | Preserved first-project copy                   |

[`skills-lock.json`](../../skills-lock.json) preserves the three externally installed skill sources and hashes. The other two supplied directories are versioned directly. Global user skills are outside the repository and were not copied; configure them separately if needed.

## Matt Pocock skills

The six complete directories `to-spec`, `to-tickets`, `implement-spec`, `tdd`, `code-review` and `codebase-design` are copied unchanged from [`mattpocock/skills` at `4ae2317ddb22b046e26455e4f9c9b3aaaf62212d`](https://github.com/mattpocock/skills/tree/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/engineering). The first two turn context into a spec and tickets; `implement-spec` orchestrates implementation. It calls `tdd` and `code-review`; `tdd` references `codebase-design` when the interface is in question. Each directory includes its upstream supporting files and agent metadata.

The upstream [MIT license and copyright notice](../../.agents/mattpocock-LICENSE) accompany the copies. The issue tracker, triage labels and domain context required by these skills are supplied by the project documentation linked from [AGENTS.md](../../AGENTS.md); the upstream setup skill itself is not included.

The complete upstream `triage`, `grilling` and `domain-modeling` directories are also pinned at the same revision and included in the integrity check. `triage` invokes the other two when clarification is needed; `grilling` requires subagents for fact-finding.

Run `mise run test:skills-integrity` to check all files in these nine directories and the license against the committed [SHA-256 manifest](../../scripts/matt-skills-sha256.json), including detection of missing and extra files. It also tests the checker. This command is included in `mise run check` and CI. The manifest records the pinned upstream contents, not an independently authenticated signature.

To update, review a specific upstream revision and its license, replace all six directories and the license with their complete unmodified upstream versions, regenerate the manifest from that revision, and run the integrity test and project checks. Review changes to dependencies and project configuration before adopting them.

`mise run test:opencode-runtime` installs the checksum-verified OpenCode 1.19.5 binary and checks isolated discovery and actual tool calls with a fixture provider. This is a local simulation of the runner, not an actual Actions execution or an end-to-end test of the workflows.

The GitHub command runtime disables external skill discovery. It copies only the nine pinned directories into isolated runtime state after checking their exact file sets and hashes; it rechecks the copy before starting the handler. The `skill` tool is allowed only for those nine names. `question` and `task` remain denied.

### Agreed scope for issue #22

The approved allowlist comprises the original six pinned Matt Pocock skills plus
`triage`, `grilling` and `domain-modeling`, requested for the new triage workflow.
Other repository, user-global, remote and built-in skills remain denied.
`question` and `task` remain denied. If an instruction
requires a user answer or delegation and cannot safely proceed without it, the
agent must report a blocker and hand the decision to a human. Silence is neither
consent nor successful completion. In particular, `implement-spec` requires
subagents, so allowing the skill does not make that workflow runnable under this
policy. The unchanged skills remain authoritative and must not be rewritten to
hide incompatible requirements.

The upstream GitHub handler publishes its own response; a denied tool call or
model instruction alone does not prove a blocked workflow cannot be presented as
a successful fix. Treat a handler success as delivery, not proof that a workflow
finished; inspect the response and tool evidence. The controlled Actions run
required by #22 must be recorded separately.

The agreed test boundaries are isolated skill discovery and real permissions on
the pinned runtime, with positive and negative cases and no unresolved requests.
These checks do not establish model reliability or GitHub Actions behavior. A
specific controlled Actions run remains necessary for the issue's acceptance;
local simulation must not be reported as an Actions run.

[`opencode.json`](../../opencode.json) and [`opencode.example.json`](../../opencode.example.json) do not configure an MCP server. No `.env`, local mise settings or credentials were migrated. For optional Render MCP setup, follow [the deployment guide](../deploy/render.md).

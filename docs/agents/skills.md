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

Run `mise run test:skills-integrity` to check all files in these six directories and the license against the committed [SHA-256 manifest](../../scripts/matt-skills-sha256.json), including detection of missing and extra files. It also tests the checker. This command is included in `mise run check` and CI. The manifest records the pinned upstream contents, not an independently authenticated signature.

To update, review a specific upstream revision and its license, replace all six directories and the license with their complete unmodified upstream versions, regenerate the manifest from that revision, and run the integrity test and project checks. Review changes to dependencies and project configuration before adopting them.

The GitHub command runtime is deliberately noninteractive: its default-deny policy does not allow the `skill`, `question` or `task` tools. In particular, the upstream workflows that require skill invocation or subagents cannot be assumed to run there merely because the files exist. This is separate from local skill availability and from CI's file-integrity check.

[`opencode.json`](../../opencode.json) and [`opencode.example.json`](../../opencode.example.json) preserve the Render MCP configuration. Authentication uses `{env:RENDER_API_KEY}`, not a literal credential. No `.env`, local mise settings or credentials were migrated. For Render MCP setup, follow [the deployment guide](../deploy/render.md).

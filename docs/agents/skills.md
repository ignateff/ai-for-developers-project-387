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

[`opencode.json`](../../opencode.json) and [`opencode.example.json`](../../opencode.example.json) preserve the Render MCP configuration. Authentication uses `{env:RENDER_API_KEY}`, not a literal credential. No `.env`, local mise settings or credentials were migrated. For Render MCP setup, follow [the deployment guide](../deploy/render.md).

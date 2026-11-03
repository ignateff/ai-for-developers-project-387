---
name: using-git-worktrees
description: Set up or reuse an isolated Git worktree for development when isolation is requested or needed; follow repository setup conventions and preserve existing work.
---

# Using Git Worktrees

Based on obra/superpowers using-git-worktrees. Follow user and repository instructions; use isolation when requested or appropriate for the task.

## Inspect and choose

1. Read applicable repository instructions, check `git status --short --branch` and `git worktree list`, and identify the intended base revision and any existing changes. A new worktree starts from a commit and does not include uncommitted or ignored files.
2. Unless a new worktree was explicitly requested, reuse a suitable existing checkout or worktree. Check its ownership and suitability rather than assuming every linked worktree is available. Check `git rev-parse --show-superproject-working-tree` before treating a submodule as an existing worktree.
3. Prefer the environment's managed worktree tool when available, following its lifecycle and attachment rules. Otherwise use `git worktree add`, an explicit base revision and a separate branch when appropriate. Follow the user's directory and branch preferences, then repository conventions. For a project-local worktree directory, verify the actual destination is ignored with `git check-ignore` before creating it; otherwise use a suitable external directory or update ignore configuration within the authorized task. Do not create a commit unless requested.
4. If creation is blocked, report the reason. Do not silently work in the original checkout when isolation was requested; continue only if that preserves the requested scope and workspace.

## Prepare and verify

Use the new worktree's path explicitly. Run the setup and relevant baseline checks documented by the repository, using its package manager and lockfile conventions. Do not infer `npm install` merely from `package.json`. Report pre-existing failures and distinguish them from changes made later.

Check project-specific requirements for ignored configuration, dependencies, generated files, hooks and services. Do not copy secrets automatically. Before running parallel servers, check port and service conflicts and use documented isolation settings; if none exist, report the limitation instead of assuming alternate ports work. Shared Git configuration and hooks can affect other worktrees.

## Handoff and cleanup

Report the worktree path, branch or detached HEAD, base, setup and baseline results, and any remaining limitations. Continue the authorized task in the selected worktree.

Before cleanup, inspect tracked, untracked and relevant ignored files, unpushed commits, and whether the worktree is shared or managed by the environment. Preserve needed work and use the owning environment's archive or cleanup mechanism for managed worktrees. For ordinary worktrees use `git worktree remove` only when safe. Never discard changes or delete branches merely to finish setup; follow the user's requested outcome.

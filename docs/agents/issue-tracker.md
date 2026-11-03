# Issue tracker: GitHub

Current issues and specs live at **https://github.com/ignateff/ai-for-developers-project-387/issues**. Use the `gh` CLI for all operations in this checkout, or pass `--repo ignateff/ai-for-developers-project-387` when working elsewhere.

Inherited specifications and decisions remain in the first project's tracker; use the explicit links in [project-history.md](project-history.md). A bare `#number` in a new issue, PR or commit refers to project **387**, not **386**. Link old issues with their full URLs; create new follow-up work in 387 without automatically closing, moving or duplicating old issues.

## Conventions

- Create: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- Read: `gh issue view <number> --json number,title,body,labels,comments`.
- List: `gh issue list --state open --json number,title,body,labels,comments` with appropriate label and state filters.
- Sub-issue: `gh issue create --parent <parent> ...` or `gh issue edit <parent> --add-sub-issue <child>`. If unavailable, put `Part of #<parent>` in the child body.
- Comment: `gh issue comment <number> --body "..."`.
- Labels: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- Close: `gh issue close <number> --comment "..."` for work resolved without a code merge.

Infer the repo from `git remote -v`; `gh` does this automatically inside a clone.

## Implementation branches

For implementation intended for `main`, open a PR from the integration branch and include `Closes #<number>` for each completed issue and specification. Keep them open until the PR merges into the default branch; a passing branch or a published commit alone does not close them. If the user explicitly requests a different delivery or closure, follow that request and record the outcome in the issues. This rule applies to implementation work; decision-only `/wayfinder` issues follow their resolution procedure below.

## Pull requests as a triage surface

**PRs as a request surface: no.** Set to `yes` if external PRs should enter the triage queue. When enabled, use `gh pr` to read, list, comment, label and close PRs. Issue and PR numbers share a namespace.

## Skill operations

- Publish to the issue tracker: create a GitHub issue.
- Fetch the relevant ticket: read the issue as above.
- `/wayfinder`: create a map issue with `wayfinder:map`, link child issues as sub-issues, and label them `wayfinder:<type>`. If sub-issues are unavailable, use a task list and `Part of #<map>`.
- Record blockers with GitHub native issue dependencies; use `Blocked by: #<number>` if unavailable. A ticket is unblocked when every blocker is closed.
- Select the first open map child with no open blockers and no assignee. Claim it with `gh issue edit <number> --add-assignee @me`.
- Resolve by commenting the answer, closing the issue, and adding a summary and link to the map's Decisions-so-far.

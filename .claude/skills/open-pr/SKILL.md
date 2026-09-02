---
name: open-pr
description: Open (or update) a pull request from the current branch to main, with a drafted tl;dr / why / how / what-changed / impact summary.
argument-hint: "(optional) extra context for the PR body, e.g. a ticket link or reviewer note"
disable-model-invocation: true
---

Opens a GitHub pull request from the current branch onto `main` — the only way changes reach `main`, since this repo blocks direct commits/pushes there and merges are squash-only (see `.claude/hooks/block-main-branch.sh`). The squash means the PR title becomes the final commit's subject line: write it as a real commit title (conventional-commit style, matching this repo's `git log`), not a restatement of the branch name.

## Steps

### 1. Preflight

- Current branch (`git branch --show-current`) must not be `main` — if it is, stop and tell the user to branch first.
- `git log main..HEAD --oneline` must be non-empty — if there's nothing ahead of `main`, stop, there's nothing to PR.
- If `git status --porcelain` shows uncommitted changes, stop and ask whether to commit them first; don't commit on the user's behalf.

### 2. Gather the diff

- `git log main...HEAD --oneline` (three-dot, against the merge-base) — the commit list.
- `git diff main...HEAD --stat` — the shape of the change.
- Scan the commit messages for issue references (`#123`, `closes ... #123`, `wayfinder #123`). Each becomes a `Closes #123` trailer in the PR body (GitHub's exact auto-close keyword) so merging closes the ticket.

### 3. Push the branch

`git push -u origin <branch>` (plain `git push` if already tracking a remote). This only ever pushes the *current* branch, never `main`.

### 4. Draft, confirm, publish

Fill the template below from the diff gathered in step 2 and anything the user passed as an argument. Show the drafted title + body to the user before publishing — the content is generated, worth a look before it becomes public.

On confirmation:

- A PR already open for this branch (`gh pr view --json number` succeeds) → update it: `gh pr edit <n> --title "..." --body "..."`.
- Otherwise → create it: `gh pr create --base main --head <branch> --title "..." --body "..."`.

Report the PR URL back to the user.

## PR body template

```markdown
## TL;DR
<one or two sentences>

## Why this change
<the motivating problem or goal>

## How
<the approach taken — key decisions, tradeoffs, or notable mechanisms; skip if the "what changed" list is already self-explanatory>

## What changed
<bullet list, grouped by area if the diff spans several>

## Impact
<user-facing, API, perf, or migration effects — "None" if genuinely none>

## Other relevant details
<anything a reviewer needs that doesn't fit above: follow-ups, known limitations, testing notes>

Closes #<n>
```

Omit the `Closes` line entirely if step 2 found no issue reference — never leave it as a placeholder.

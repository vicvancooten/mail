---
name: assembly-line
description: "Run a group of ready implementation tickets to Done unattended — one dependency order, N workers in flight, each in its own worktree, merged into trunk the moment it lands."
disable-model-invocation: true
---

# Assembly line

A **line** runs a group of implementation tickets — already sharp, already blocking-wired, typically what `/wayfinder` and `/to-tickets` left behind — to Done with no human driving.

You are the **scheduler**. Settle the run once, then loop: dispatch every takeable ticket, merge each the moment it lands, dispatch whatever that unblocked. You write no feature code; **workers** do, each in a clean context window. The line optimises three things, in this order: wall-clock, your own context window, human interruptions.

- **Trunk** — one branch and worktree for the whole feature. Every ticket merges here; it is the deliverable.
- **Order** — all tickets in one dependency-sorted list. There are no batches: list position plus blocker state decides who flies next.
- **Frontier** — the tickets takeable right now: every blocker merged, not stalled, not in flight.
- **Tick** — one worker returning. Every tick lands its ticket, then refills the frontier up to N.
- **Worker** — one `claude` process on one ticket, in its own worktree, with its own model and effort.
- **Manifest** — the run state, one comment on the parent issue: settings, order, statuses. What a later session resumes from.
- **Stall** — one ticket waiting on a human. A stall holds the ticket, never the line.
- **Budget** — your context window. Soft line ~120k tokens, hard line ~250k.

Issue-tracker operations: `docs/agents/issue-tracker.md`. HITL/AFK labels: `docs/agents/triage-labels.md`.

## 1. Pin the ticket set

The line needs a **clear group**: a parent issue's sub-issues, a milestone, a project, or an explicit list of identifiers. If the ask doesn't resolve to one, ask for it and go no further.

The parent issue is the deliverable: children go straight to Done, the parent carries the review gate. No parent → propose one (title, description, the children it adopts) and get an explicit yes before creating or re-parenting anything. A manifest already on the parent → jump to Resume.

## 2. Settle the run

One `AskUserQuestion` call, four questions, then nothing more is asked of the user until a round-off:

1. **Trunk branch** — propose `feat/<slug>` from the parent title.
2. **Output** — a PR on close-out (default), or the branch only.
3. **N** — workers in flight at once (default 4).
4. **Budget mode** — *ask* at the soft line (default), or *run* to the hard line.

Done when you hold all four; they become the manifest header.

## 3. Plan the order

Cut the trunk first: `git worktree add .claude/worktrees/<trunk-slug> -b <trunk> main`. The line runs entirely in worktrees; the user's checkout stays untouched.

Then dispatch a **planner** (sonnet · medium, mechanics under Workers) instead of reading ticket bodies yourself — bodies are the largest thing you could put in your window. Its prompt is the group plus a pointer to this file's §3, §4 and Model policy; it fetches every ticket with `includeRelations: true` and returns the manifest table, nothing else:

- **Order**: topological over blocking edges; ties → the ticket that unblocks the most first, then map order.
- **Model · effort** per ticket, by the policy under Workers, with a one-clause reason for anything above the default.
- **One hard gate**: two tickets that both add a Drizzle migration never fly together — the later one goes `after` the earlier. Other file overlap only orders; it never gates. Conflicts are payable, waiting is not.
- `ready-for-human` tickets start stalled.

Post the manifest. Done when every ticket has a row, a model and an `after` column you can schedule from without touching Linear again.

## 4. The manifest

```markdown
## Assembly line manifest

Trunk `feat/<slug>` at `<path>` · output: PR · N=4 · budget: ask at 120k

| # | Ticket | Model | After | Status |
|---|--------|-------|-------|--------|
| 1 | [CPE-1 title](url) | sonnet·medium | — | merged |
| 2 | [CPE-2 title](url) | sonnet·high | 1 | in flight — `<branch>`, worker `<name>` |
| 3 | [CPE-3 title](url) | sonnet·medium | 1 | stalled — <exactly what the human must do> |
| 4 | [CPE-4 title](url) | sonnet·medium | 2, 3 | queued |

Sessions: 1 — landed #1, rounded off at soft line · 2 — …
```

Edited in place after every tick. `After` names rows, so the frontier is computable from this table alone.

## 5. Run the line

Open by dispatching the whole frontier, up to N. From then on you run on ticks — handle each worker return the moment it arrives, never waiting for its siblings:

1. **Land.** Report says `done` and `git log <trunk>..<branch>` is non-empty → from the trunk worktree `git merge --no-ff <branch>`, then `git worktree remove` and `git branch -d`. A conflict goes to a conflict worker on trunk; you merge nothing by hand. While a conflict or fix worker holds trunk, further landings queue behind it — refilling continues. Any other report → Failures and stalls.
2. **Gate trunk** in the background: `(pnpm lint && pnpm test) 2>&1 | tail -40` from the trunk worktree with `run_in_background`, one gate at a time — a merge landing during a gate is covered by the next one. Red → a fix worker on trunk carrying the tail.
3. **Refill.** Recompute the frontier from the manifest and dispatch until N are in flight. A ticket this merge unblocked flies now.
4. **Manifest.** Edit the comment.
5. **Budget.** Estimate your window; past a line → Budget and round-off.

Done when the frontier is empty and nothing is in flight. Stalls remaining → round off; none → Close out.

## Workers

### Model policy

**Sonnet · medium is the worker.** Wayfinder did the thinking; a sharp vertical slice with tests is squarely sonnet work. Escalate one step at a time, for a reason you can write in the manifest:

- **sonnet · high** — the ticket crosses three layers (schema, data, UI), its body leaves a design choice open, or it is a retry.
- **opus · medium** — a novel architectural seam, a cross-cutting refactor, or a second retry. Exceptional: pick it only when it is plainly cheaper than another sonnet pass.
- Planner, conflict and fix workers: sonnet · medium.

### Dispatch

Write the prompt to a file in a temp dir (an inline multi-line prompt breaks quoting), then one `run_in_background` command that cuts the worktree, gives it dependencies and env, and chains the worker — you never wait on any of it:

```bash
git worktree add .claude/worktrees/<id> -b <gitBranchName> <trunk> \
  && { cp .env .claude/worktrees/<id>/ 2>/dev/null; true; } \
  && ( cd .claude/worktrees/<id> \
       && pnpm install --prefer-offline >/dev/null \
       && claude -p --model sonnet --effort medium --permission-mode auto \
            "$(cat <tmp>/<id>.prompt)" ) 2>&1 | tail -30
```

The completion notification carries the worker's report. `--permission-mode auto` has a classifier approve routine tool calls, so nothing prompts and nothing waits on a human. Planner, conflict and fix workers run the same way from the trunk worktree, without the `git worktree add`.

`HERDR_ENV=1` → the user is watching in herdr; dispatch per [`herdr.md`](herdr.md) instead.

### Prompt

The worker starts with a clean context window, so everything it needs rides in the prompt:

<dispatch-prompt>

Implement <ticket id> — <ticket title>: <URL>

Your worktree: <absolute path>, on branch `<ticket-branch>` off `<trunk-branch>`. Work only there; that path is yours alone.

Read `.agents/skills/implement/SKILL.md` and follow it, with these changes:

- Skip `/code-review`. The whole feature is reviewed once, after every ticket has landed.
- Move the ticket to **Done** when you finish. It is a child issue; the parent carries the review gate.
- Decide routine calls yourself and record them in your closing Linear comment. Report `stalled` only when every assumption you could make would waste the ticket.

Before you report: `git merge <trunk-branch>` into your branch and resolve what it raises — regenerate `messages/` and `drizzle/` rather than hand-merging them — then `pnpm lint` and `pnpm test` green, and all work committed to `<ticket-branch>`.

Report in exactly this shape, ten lines at most:

STATUS: done | stalled | failed
Shipped: …
Verified: …
Deferred: …
Question: <only what a human must answer, else omit>

</dispatch-prompt>

## Failures and stalls

**Failed** — report says `failed`, or the worker exits without Done: redispatch on the same branch (its worktree stays), the failed report in the prompt, one escalation step up: medium → high → opus · medium → stall. Three strikes is a stall.

**Stalled** — report says `stalled`, or the ticket is `ready-for-human`: manifest row → stalled with the exact human action, branch kept, tickets `after` it stay queued, everything else keeps flying. Stalls are collected for the round-off message, never announced one by one.

## Budget and round-off

You cannot read your own window, so estimate it: every tick adds a report, a merge, a gate tail and a manifest edit. Lean early — a round-off costs one manifest edit, an overrun costs every later turn.

- **Soft line (~120k), mode ask** → stop refilling, land what is in flight (outside herdr a worker dies with your session; inside herdr it survives — record its name and round off at once), then round off.
- **Soft line, mode run** → keep going.
- **Hard line (~250k)** → round off whatever the mode.

Round off = manifest brought to reality (statuses, stalls with their human action, a `Sessions` entry), then one message:

> Landed #…; in flight/queued …; stalled … (what to do). Continue with `/clear` then `/assembly-line <parent>` — or say "keep iterating" and I carry on in this window.

"keep iterating" → refill and run to the hard line.

## Close out

1. Final trunk gate green.
2. `/code-review` over the whole feature diff — fixed point `main`, from the trunk worktree, spec source the parent and its children. One review over everything is why the workers skipped theirs.
3. Fix workers on trunk for the findings that hold, one per file area, in parallel. Gate again.
4. Parent → **In Review**, closing comment: what shipped, what was verified, what was deferred.
5. Output as settled in step 2: PR → `/create-pr`; branch → report its name. The trunk worktree stays until the PR merges.

## Resume

A manifest exists → its header is your settings; ask nothing. Reconcile before trusting a word of it: the children's Linear states, `git worktree list`, `git log <trunk>` for what actually merged, `herdr agent list` inside herdr. Reality wins; rewrite the manifest, then dispatch the frontier.

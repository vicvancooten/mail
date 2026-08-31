---
name: assembly-line
description: "Run a group of ready implementation tickets to done unattended — dependency-ordered waves, a fresh subagent and worktree per ticket, one review at the end."
disable-model-invocation: true
---

# Assembly line

A **line** runs a group of implementation tickets — already sharp, already blocking-wired, typically what `/wayfinder` and `/to-tickets` left behind — to Done without a human driving each one.

You are the coordinator: you plan the order, dispatch a fresh subagent per ticket, merge what comes back, and keep the line moving. You write no feature code yourself; all of it comes from dispatched agents, each with a clean context window.

- **Trunk** — one branch and worktree for the whole feature. Every ticket merges here; it becomes the PR.
- **Wave** — the tickets dispatched concurrently. Usually one ticket wide.
- **Manifest** — the run state, held as a comment on the parent issue. The thing a later session resumes from.
- **Stall** — the line halted, waiting on a human.

Issue-tracker operations: `docs/agents/issue-tracker.md`. HITL/AFK roles map to labels in `docs/agents/triage-labels.md`.

## 1. Pin the ticket set

The line needs a **clear group**: a parent issue's sub-issues, a milestone, a project, or an explicit list of identifiers. If the user's ask doesn't resolve to one, ask for it and go no further — a line over a guessed set of tickets is worse than no line at all.

Fetch every ticket with `includeRelations: true`. Per ticket you need: title, state, blocking edges, HITL/AFK role, and enough body to judge complexity and which files it touches. Tickets already in a completed state are behind you — that's what makes resume cheap.

## 2. Settle the parent issue

The parent is the **deliverable**: children go straight to Done, the parent carries the review gate.

Group already has a parent → use it. No parent → propose one (title, description, the children it will adopt) and get the user's explicit yes before creating it or re-parenting anything.

## 3. Plan the line

Order by blocking edges: a ticket is takeable when every blocker sits in a completed state.

**Concurrency is the exception.** Put two tickets in one wave only when both are takeable _and_ their bodies point at disjoint file areas. Overlapping footprints get separate waves — concurrent agents editing the same files burn tokens fighting each other and hand you a merge conflict to pay for afterwards. A dependent ticket starts only once its blockers are merged into trunk, so its worktree branches off a trunk that already contains them.

Cut the trunk before dispatching anything: a branch off `main` with its own worktree. The line runs entirely in worktrees — the user's own checkout stays untouched.

Assess each ticket's model while you plan. **Sonnet is the model.** Wayfinder has already done the thinking, and a sharp vertical slice with tests is squarely sonnet work. Reach for opus only on exceptional complexity: a novel architectural seam, a cross-cutting refactor, or a ticket whose own body says the approach is still unresolved. Assume sonnet until the ticket proves otherwise.

Show the user the plan — waves, model per ticket, trunk branch — then write the manifest and start.

## 4. The manifest

One comment on the parent issue, edited in place after every ticket lands. It is what a later session reads to pick the line back up.

```markdown
## Assembly line manifest

Trunk: `<branch>` at `<worktree path>`

1. [Ticket title](link) — sonnet — merged
   [Ticket title](link) — sonnet — merged
2. [Ticket title](link) — opus — in flight, `<branch>` at `<path>`
3. [Ticket title](link) — HITL — stalled: <what the human must do>
4. [Ticket title](link) — sonnet — queued
```

## 5. Run the line

Per wave, in order:

1. **Cut a worktree** per ticket, branched off trunk.
2. **Dispatch** one subagent per ticket (below).
3. **Wait.** The completion signal is the ticket reaching Done in Linear — not the agent falling quiet.
4. **Merge back** into trunk in wave order, then remove the ticket worktree. Conflicts get resolved on trunk with `/resolving-merge-conflicts`.
5. **Update the manifest** before the next wave opens.

## Dispatch

The subagent starts with a clean context window, so everything it needs rides in the prompt:

<dispatch-prompt>

Implement <ticket id> — <ticket title>: <URL>

Your worktree: <absolute path>, on branch `<ticket-branch>` off `<trunk-branch>`. Work only there; that path is yours alone.

Follow the `/implement` skill, with two changes:

- Skip `/code-review`. The whole feature is reviewed in one pass once every ticket has landed.
- Move the ticket to **Done** when you finish. It is a child issue; the parent carries the review gate.

Before you report back: `pnpm lint` and `pnpm test` pass, and your work is committed to `<ticket-branch>`.

Report back: what shipped, what you verified, what you deferred, and any question only the human can answer.

</dispatch-prompt>

### Inside herdr

`HERDR_ENV=1` means the user is watching in herdr, so each ticket gets its own herdr worktree and a visible claude agent inside it. The `herdr` binary is the authority on syntax — read `herdr --skill`, then the `herdr worktree` and `herdr agent` groups, and take every id out of the JSON responses:

- `herdr worktree create` with the ticket branch based on trunk, labelled with the ticket id.
- Start a claude agent in that workspace's pane, passing the chosen model as a native arg after `--` (`-- --model sonnet`).
- `herdr agent prompt` with the dispatch prompt, then wait on lifecycle state with a generous timeout, re-waiting until the ticket reads Done in Linear. On `blocked`, `herdr agent read` and deal with what it found: an approval prompt you can answer, or a real question — which is a stall.
- Keep the user's focus where they left it (`--no-focus`).

### Outside herdr

`git worktree add .claude/worktrees/<ticket-branch-slug> -b <ticket-branch> <trunk-branch>`, then dispatch with the Agent tool: `subagent_type: "general-purpose"`, `model: "sonnet"` or `"opus"`, the dispatch prompt naming that path. A wave of two goes out as two Agent calls in one message.

## Stalls

A ticket carrying the `ready-for-human` role, or a dispatched agent surfacing a question only the human can answer, stalls the line.

1. Land and merge whatever is still in flight, so trunk is clean.
2. Update the manifest: which ticket stalled and what it waits on.
3. Tell the human in the console: which ticket, why it needs them, exactly what to do, and — "mark it Done in Linear, then run `/assembly-line <parent>` to pick the line back up."
4. Stop there.

## Close out

Once the last ticket is merged into trunk:

1. `/code-review` over the whole feature diff — fixed point `main`, run from the trunk worktree, spec source the parent issue and its children. One review over everything is the whole reason the per-ticket agents skipped theirs.
2. Dispatch fix subagents on trunk for the findings that hold up, serially.
3. Re-run the gates: `pnpm lint`, `pnpm test`.
4. Parent issue → **In Review**, with a closing comment: what shipped, what was verified, what was deferred.
5. Offer the PR. On the user's yes, `/create-pr`. Leave the trunk worktree in place until it merges.

## Resume

`/assembly-line <parent issue>` over a line that already exists: read the manifest, then **reconcile it against reality before trusting a word of it** — the children's Linear states, `git worktree list`, and `git log <trunk-branch>` to see what actually merged. Reality wins; rewrite the manifest to match, then open the first unfinished wave.

# Dispatching inside herdr

`HERDR_ENV=1`: the user is watching in herdr, so each worker gets its own herdr worktree and a visible claude agent inside it. The `herdr` binary is the authority on syntax — read `herdr worktree` and `herdr agent` (the group without a subcommand prints its commands) and take every id out of the JSON responses.

## Dispatch

1. `herdr worktree create --branch <gitBranchName> --base <trunk> --label <ticket id> --no-focus` → the pane id from the response. Copy `.env` in and run `pnpm install --prefer-offline` in that pane before the agent starts.
2. `herdr agent start <ticket-id-slug> --kind claude --pane <pane id> -- --model <model> --effort <effort> --permission-mode auto`. The agent name is the ticket id, lower-cased; it goes in the manifest.
3. `herdr agent prompt <name> "<dispatch prompt>"` — no `--wait`.
4. Arm a tick: `herdr agent wait <name> --until done --until idle --until blocked --timeout <ms>` with `run_in_background`. Each returning wait is one tick; a wait that times out is re-armed, not a completion.

Keep the user's focus where they left it: `--no-focus` everywhere.

## On a tick

- `done` / `idle` → `herdr agent read <name> --lines 40` for the STATUS report, then land as in `SKILL.md`. Remove the worktree with `herdr worktree remove`.
- `blocked` → `herdr agent read <name>`. An approval prompt you can answer → `herdr agent send-keys`, re-arm the wait. A question only the human can answer → stall.

## Round-off

Herdr agents outlive your session. Round off at once with every in-flight worker's name in its manifest row; a resuming session re-arms a wait per name after `herdr agent list`.

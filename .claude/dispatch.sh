#!/usr/bin/env bash
# usage: dispatch.sh <agent-name> <issue-number> <branch> <path> <think-directive>
set -euo pipefail
NAME=$1; NUM=$2; BRANCH=$3; WTPATH=$4; THINK=$5
TITLE=$(gh issue view "$NUM" --json title -q .title)
read -r -d '' PROMPT <<EOF || true
/implement #${NUM} — ${TITLE}: https://github.com/vicvancooten/mail/issues/${NUM}

${THINK}

Your worktree: ${WTPATH}, on branch \`${BRANCH}\` off \`feat/poc-build\` (the assembly-line trunk). Work only there; that path is yours alone. Run \`pnpm install\` first — it is a fresh checkout.

Read the ticket body and every spec it cites before writing code: docs/poc-spec.md, docs/poc-scope.md, docs/compose-spec.md, docs/search-ux-spec.md, CONTEXT.md, docs/dev-setup.md, and the docs/adr/ files it names. ADRs win where the spec disagrees. The ticket's checkbox list is the acceptance bar — every box must be genuinely true, tested where testable.

Two changes to the skill's instructions:

- **Skip \`/code-review\`.** The whole feature gets one review pass on the trunk once every ticket on the line has landed. Do not run it.
- **Close the issue when you finish**: \`gh issue close ${NUM} --comment "<what shipped>"\`. It is a child of #30; the parent carries the review gate. \`gh\` needs the Bash sandbox disabled in this environment — pass dangerouslyDisableSandbox if a gh call returns empty output.

Everything else in the skill stands, in particular: exactly ONE Conventional Commit on \`${BRANCH}\` closing #${NUM}, no self-attribution (no \`Co-Authored-By\`, no "generated with" footer, no 🤖), and no push. Squash as you go or at the end — the branch must end as a single commit on top of trunk.

Before you report back: \`pnpm lint\` and \`pnpm test\` pass from the worktree root, \`pnpm typecheck\` is clean, and your work is committed to \`${BRANCH}\`.

Report back: what shipped, what you verified, what you deferred, and any question only the human can answer.
EOF
herdr agent prompt "$NAME" "$PROMPT" --wait --timeout 20000 2>&1 | head -c 200

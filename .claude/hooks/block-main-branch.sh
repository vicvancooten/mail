#!/bin/bash
# Blocks direct commits and pushes to main from within Claude Code.
#
# Local-only guardrail: this repo is private on GitHub's free plan, where
# native branch protection / rulesets 403. Doesn't stop manual git or the
# GitHub web UI — branch off main and open a PR (see the open-pr skill).

INPUT=$(cat)
# No jq dependency assumed present on the host; node ships with this repo's
# tooling and is always on PATH here.
COMMAND=$(echo "$INPUT" | node -e '
  let d = "";
  process.stdin.on("data", c => d += c);
  process.stdin.on("end", () => {
    try { process.stdout.write(JSON.parse(d).tool_input?.command ?? ""); }
    catch { process.stdout.write(""); }
  });
')
[ -z "$COMMAND" ] && exit 0

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)

block() {
  echo "BLOCKED: '$COMMAND' — direct commits/pushes to main are not allowed. Branch off main and open a PR instead (see the open-pr skill)." >&2
  exit 2
}

# A commit while checked out on main.
if [ "$CURRENT_BRANCH" = "main" ] && echo "$COMMAND" | grep -qE '(^|&&|;|\|)[[:space:]]*git commit\b'; then
  block
fi

# A push while checked out on main (covers plain `git push`, `git push origin`, etc.).
if [ "$CURRENT_BRANCH" = "main" ] && echo "$COMMAND" | grep -qE '(^|&&|;|\|)[[:space:]]*git push\b'; then
  block
fi

# A push that explicitly targets main as the remote ref, from any branch
# (e.g. `git push origin main`, `git push origin HEAD:main`, `git push origin :main`).
if echo "$COMMAND" | grep -qE '(^|&&|;|\|)[[:space:]]*git push\b' \
  && echo "$COMMAND" | grep -qE '[[:space:]:]main([[:space:]]|$)'; then
  block
fi

exit 0

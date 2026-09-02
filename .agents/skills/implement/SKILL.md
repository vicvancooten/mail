---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

Implement the work described by the user in the spec or tickets.

Use /tdd where possible, at pre-agreed seams.

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

Once done, use /code-review to review the work.

Commit your work to the current branch: **one ticket, one commit**, written as a [Conventional Commit](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `chore:` …) closing the ticket it resolves. No agent self-attribution in the message — no `Co-Authored-By` trailer, no "generated with" footer. Don't push; the human handles that.

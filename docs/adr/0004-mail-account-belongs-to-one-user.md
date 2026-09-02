# A Mail Account belongs to exactly one User

Two household members following the same mailbox each add their own Mail Account, with their own credentials, their own sync, and their own Gatekeeper verdicts — the second person starts from a blank verdict slate. There is no sharing and no `(User, MailAccount)` join.

## Considered Options

- **Instance-level Mail Accounts with per-User state rows**: rejected — it only pays off for genuinely *shared* state (one person's archive affecting the other's), which is a workplace pattern, not a household one. It buys that at the cost of a join table, permission checks, and forked read/flag semantics on every query.

## Consequences

- Duplicate sync when two Users follow one mailbox: two IMAP connections, two synced copies. Irrelevant at single-household scale, and the reason a future reader should not "fix" this by de-duplicating Mail Accounts.
- Ownership is the only authorization primitive: every query is scoped by User.
- Credentials, Gatekeeper verdicts, pins, labels and Snooze all hang off the Mail Account, so none of them need a User dimension of their own.

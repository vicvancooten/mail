/**
 * Deterministic Gmail Label identity (#126, ADR-0020). Gmail — not the User —
 * assigns a label's path, so unlike a Wicket `Label` (`labels.ts`'s
 * `labelId`) there is no offline-creation case this needs to support; the id
 * is derived rather than server-minted anyway, so `sync/gmail-labels.ts`
 * (Sync Backend) can upsert a discovered label by id with no lookup-by-path
 * round trip first, and so `Thread.gmailLabelIds` — built straight off a
 * message's raw `X-GM-LABELS` values, never a join — always names the same
 * row the `GmailLabel` collection itself does.
 */
export function gmailLabelId(mailAccountId: string, path: string): string {
  return `${mailAccountId}:${path}`;
}

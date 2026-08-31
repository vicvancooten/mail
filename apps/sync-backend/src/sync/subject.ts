/**
 * Subject normalization for Thread display (#34).
 *
 * This is *only* used to pick the words a Thread is labelled with — it is
 * deliberately not part of threading itself (see `db/schema.ts` on
 * `thread_message_ids`: threading is reference-based, with no subject
 * fallback). Per-message subjects are stored verbatim on `messages.subject`.
 */

/**
 * Reply/forward prefixes seen on the PoC's target mail: English, Dutch (this
 * mailbox is mixed — the same reason ADR-0016 refuses a stemmed search
 * configuration), plus the German/French ones that ride along in European
 * threads. The optional `[n]`/`(n)` counter is Outlook's "Re[2]:".
 */
const REPLY_PREFIX =
  /^\s*(?:(?:re|aw|antw|antwoord|fwd?|wg|doorst|tr|rv|sv|vs)\s*(?:\[\d+\]|\(\d+\))?\s*:\s*)+/i;

/** A leading mailing-list tag, e.g. `[postgres-hackers] `. */
const LIST_TAG = /^\s*\[[^\]]{1,40}\]\s*/;

/**
 * Strips reply/forward prefixes and a leading list tag, collapsing
 * whitespace. Applied repeatedly because real subjects stack them
 * (`Re: [list] Fwd: Re: ...`).
 */
export function baseSubject(subject: string | null | undefined): string {
  let current = (subject ?? "").replace(/\s+/g, " ").trim();
  for (let pass = 0; pass < 8; pass += 1) {
    const stripped = current.replace(REPLY_PREFIX, "").replace(LIST_TAG, "");
    if (stripped === current) break;
    current = stripped.trim();
  }
  return current;
}

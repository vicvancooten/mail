import { lte } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { threads } from "../db/schema.js";

/**
 * The Snooze wake sweep (#76, CONTEXT.md: "hiding a thread until a chosen
 * time, after which it returns as new"). A snoozed Thread carries no
 * Client-sent "wake" intent of its own — `sync/mutations.ts`'s `snooze`
 * case is one-directional, same as `archive`/`trash` — so this is the only
 * writer that ever clears `snoozeUntil` again, on a plain interval
 * (`snooze-wake-loop.ts`), independent of any Client being connected at
 * all (ADR-0003: the Sync Backend keeps working while every User is signed
 * out).
 *
 * "Returns to the Inbox as new" is read literally but narrowly: `inInbox`
 * flips back to `true` and `snoozeUntil` clears, exactly undoing the two
 * fields `snooze` itself set — never `unreadCount`/`lastMessageAt`, which
 * are `thread-rollup.ts`'s own IMAP-truth columns and would just be
 * clobbered by the next rollup anyway (a new message on the same Thread, an
 * unrelated flag change). A woken Thread reads as an ordinary Inbox Thread
 * again, at its own real date — not specially marked, which is what "no
 * IMAP-side trace" (ADR-0006) means applied to the wake half of the
 * feature too.
 *
 * The trigger on `threads` (migration 0006) bumps `sync_rev` on this UPDATE
 * the same as any other write, so a woken Thread simply shows up in
 * whichever Client's next `POST /sync` — no push, no special-cased delta.
 */
export async function wakeDueSnoozes(db: Db, now: Date = new Date()): Promise<number> {
  const result = await db
    .update(threads)
    .set({ snoozeUntil: null, inInbox: true })
    .where(lte(threads.snoozeUntil, now))
    .returning({ id: threads.id });
  return result.length;
}

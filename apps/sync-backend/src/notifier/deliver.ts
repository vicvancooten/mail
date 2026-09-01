import type { PushPayload } from "@mail/shared";
import type { Db } from "../db/client.js";
import type { PushSubscriptionRow } from "../db/schema.js";
import { computeUnreadInboxCount } from "./badge.js";
import { listUndelivered, markDelivered, type NotifierOutboxRow } from "./outbox.js";
import { NEW_MAIL_BURST_CAP } from "./policy.js";
import { deletePushSubscriptionById, listPushSubscriptionsForUser } from "./subscriptions.js";

/**
 * Delivers the Notifier's outbox to every subscribed device (#53,
 * ADR-0015). "Every subscribed device is pushed; you never know which one is
 * in someone's hand" — there is no server-side awake/visible tracking here,
 * that decision is the service worker's (`suppressed only when that thread
 * is already the open one`, per the ADR — a client-side call the SW makes
 * with `clients.matchAll`, nothing this module can see).
 */

/** One subscription's send outcome — `expired` is RFC 8030's standard signal (a `404`/`410`) that this subscription is dead. */
export type SendPushResult = { ok: true } | { ok: false; expired: boolean };

export type SendPushFn = (
  subscription: PushSubscriptionRow,
  payload: PushPayload,
) => Promise<SendPushResult>;

export interface DeliverPendingOptions {
  sendPush: SendPushFn;
}

export interface DeliverPendingResult {
  /** Individual pushes actually sent (post-collapse), across every subscription attempted. */
  sent: number;
  /** Outbox rows collapsed into a burst push rather than sent individually. */
  collapsed: number;
  /** Subscriptions pruned this tick after a `404`/`410`. */
  pruned: number;
}

/**
 * One delivery tick: every undelivered outbox row, grouped by Mail Account
 * so a `new_mail` burst collapses per-account (poc-scope.md), sent to every
 * device subscribed for that row's User.
 */
export async function deliverPending(
  db: Db,
  options: DeliverPendingOptions,
): Promise<DeliverPendingResult> {
  const pending = await listUndelivered(db);
  const result: DeliverPendingResult = { sent: 0, collapsed: 0, pruned: 0 };
  if (pending.length === 0) return result;

  const byAccount = new Map<string, NotifierOutboxRow[]>();
  for (const row of pending) {
    const bucket = byAccount.get(row.mailAccountId);
    if (bucket) bucket.push(row);
    else byAccount.set(row.mailAccountId, [row]);
  }

  for (const rows of byAccount.values()) {
    const userId = rows[0]?.userId;
    if (userId === undefined) continue;
    const subscriptions = await listPushSubscriptionsForUser(db, userId);
    const badgeCount = await computeUnreadInboxCount(db, userId);

    const newMail = rows.filter((row) => row.kind === "new_mail");
    const others = rows.filter((row) => row.kind !== "new_mail");

    if (newMail.length > NEW_MAIL_BURST_CAP) {
      // Collapse — "past ~5 pushes in a short window, collapse into one 'N
      // new messages'" (poc-scope.md). One combined push covers every
      // pending row for this account at once, not just the ones past the cap.
      const payload: PushPayload = {
        kind: "new_mail_burst",
        mailAccountId: newMail[0]?.mailAccountId ?? "",
        count: newMail.length,
        badgeCount,
      };
      const delivered = await sendToEverySubscription(
        db,
        subscriptions,
        payload,
        options.sendPush,
        result,
      );
      if (delivered) {
        await markDelivered(
          db,
          newMail.map((row) => row.id),
        );
        result.collapsed += newMail.length;
      }
    } else {
      for (const row of newMail) {
        const payload = toPayload(row, badgeCount);
        const delivered = await sendToEverySubscription(
          db,
          subscriptions,
          payload,
          options.sendPush,
          result,
        );
        if (delivered) await markDelivered(db, [row.id]);
      }
    }

    for (const row of others) {
      const payload = toPayload(row, badgeCount);
      const delivered = await sendToEverySubscription(
        db,
        subscriptions,
        payload,
        options.sendPush,
        result,
      );
      if (delivered) await markDelivered(db, [row.id]);
    }
  }

  return result;
}

/**
 * Attempts one payload against every one of a User's devices. Prunes a
 * subscription outright on `expired` (RFC 8030's `404`/`410` — ADR-0015).
 * Returns whether the *event* should be considered delivered: true whenever
 * every subscription either succeeded or was pruned, so a genuinely
 * transient failure (the push service itself unreachable, say) is the only
 * thing that leaves the outbox row for the next tick to retry — a retry
 * that re-sends to subscriptions that already got it, an accepted cost for
 * how rarely that path runs.
 */
async function sendToEverySubscription(
  db: Db,
  subscriptions: PushSubscriptionRow[],
  payload: PushPayload,
  sendPush: SendPushFn,
  result: DeliverPendingResult,
): Promise<boolean> {
  // No device subscribed at all — nothing more will ever come of waiting,
  // so the event is "delivered" in the sense that there is no retry that
  // could help.
  if (subscriptions.length === 0) return true;

  let allOk = true;
  for (const subscription of subscriptions) {
    const outcome = await sendPush(subscription, payload);
    if (outcome.ok) {
      result.sent += 1;
      continue;
    }
    if (outcome.expired) {
      await deletePushSubscriptionById(db, subscription.id);
      result.pruned += 1;
      continue;
    }
    allOk = false;
  }
  return allOk;
}

function toPayload(row: NotifierOutboxRow, badgeCount: number): PushPayload {
  const payload = row.payload;
  switch (payload.kind) {
    case "new_mail":
      return {
        kind: "new_mail",
        mailAccountId: row.mailAccountId,
        threadId: payload.threadId,
        senderName: payload.senderName,
        senderAddress: payload.senderAddress,
        subject: payload.subject,
        snippet: payload.snippet,
        badgeCount,
      };
    case "failed_send":
      return {
        kind: "failed_send",
        mailAccountId: row.mailAccountId,
        compositionId: payload.compositionId,
        subject: payload.subject,
        detail: payload.detail,
        badgeCount,
      };
    case "needs_reauth":
      return {
        kind: "needs_reauth",
        mailAccountId: row.mailAccountId,
        emailAddress: payload.emailAddress,
        badgeCount,
      };
    case "gatekeeper_digest":
      return {
        kind: "gatekeeper_digest",
        mailAccountId: row.mailAccountId,
        senders: payload.senders,
        count: payload.count,
        badgeCount,
      };
  }
}

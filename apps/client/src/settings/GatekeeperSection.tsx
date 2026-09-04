import type { GatekeeperSender, GatekeeperStatusResponse, MailAccount } from "@mail/shared";
import { useCallback, useEffect, useState } from "react";
import {
  disableGatekeeper,
  enableGatekeeper,
  fetchGatekeeperStatus,
  resetGatekeeper,
} from "../api/gatekeeper.js";
import { enqueueMutation } from "../store/index.js";

function senderKey(sender: Pick<GatekeeperSender, "scope" | "value">): string {
  return `${sender.scope}:${sender.value.trim().toLowerCase()}`;
}

/**
 * Gatekeeper's per-Mail-Account settings (#56, poc-spec.md §Gatekeeper v1):
 * the enable/disable switch, Reset, and the Blocked Senders list — "there is
 * no Approved list" (the ticket), only this one. A plain fetched screen, not
 * a Local Cache read: `routes/gatekeeper.ts`'s own doc comment is explicit
 * that this is "a request the User waits on and sees the result of", the
 * same split `api/send-settings.ts` already draws.
 *
 * The Blocked Senders list's own Unblock rides the ordinary Optimistic
 * Action queue (`unblockSender`) rather than a dedicated route — it queues
 * offline and shows immediately, the row removed from local state on click
 * rather than waiting on a round trip, matching the Screener's own "the row
 * leaving is the optimistic feel" (`mutation-queue.ts`'s doc comment).
 *
 * Names the Mail Account it changes in its own heading (#82: "Gatekeeper
 * settings name the account they change; no setting inherits Scope") —
 * `account` always names one real account, never Account Scope (#73), so a
 * Verdict from here is never at risk of landing on the wrong mailbox.
 */
export function GatekeeperSection({ account }: { account: MailAccount }) {
  const [status, setStatus] = useState<GatekeeperStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [unblocked, setUnblocked] = useState<ReadonlySet<string>>(new Set());

  const reload = useCallback(() => {
    return fetchGatekeeperStatus(account.id)
      .then((response) => {
        setStatus(response);
        setUnblocked(new Set());
      })
      .catch(() => setError("Couldn't load Gatekeeper settings."));
  }, [account.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function toggle(enabled: boolean) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = enabled
        ? await enableGatekeeper(account.id)
        : await disableGatekeeper(account.id);
      setStatus(response);
      setUnblocked(new Set());
      if (enabled && response.seeded > 0) {
        setMessage(
          `Approved ${response.seeded} sender${response.seeded === 1 ? "" : "s"} from your Sent history.`,
        );
      }
    } catch {
      setError(enabled ? "Couldn't turn on Gatekeeper." : "Couldn't turn off Gatekeeper.");
    } finally {
      setBusy(false);
    }
  }

  async function handleReset() {
    setConfirmingReset(false);
    setBusy(true);
    setError(null);
    try {
      const response = await resetGatekeeper(account.id);
      setStatus(response);
      setUnblocked(new Set());
      setMessage(
        `Reset. Approved ${response.seeded} sender${response.seeded === 1 ? "" : "s"} from your Sent history again.`,
      );
    } catch {
      setError("Couldn't reset Gatekeeper.");
    } finally {
      setBusy(false);
    }
  }

  function unblock(sender: GatekeeperSender) {
    void enqueueMutation({ type: "unblockSender", sender }, account.id);
    setUnblocked((current) => new Set(current).add(senderKey(sender)));
  }

  if (!status) {
    return (
      <section className="gatekeeper-settings">
        <h4>Gatekeeper — {account.emailAddress}</h4>
        {error ? <p role="alert">{error}</p> : <p>Loading…</p>}
      </section>
    );
  }

  const blocked = status.blocked.filter((sender) => !unblocked.has(senderKey(sender)));

  return (
    <section className="gatekeeper-settings">
      <h4>Gatekeeper — {account.emailAddress}</h4>
      <p className="gatekeeper-settings-description">
        Hold mail from senders you've never approved in the Screener, so a stranger waits for a
        decision instead of landing straight in the Inbox.
      </p>
      {error && <p role="alert">{error}</p>}

      <label>
        <input
          type="checkbox"
          checked={status.gatekeeper.enabled}
          disabled={busy}
          onChange={(event) => void toggle(event.target.checked)}
        />
        Enabled
      </label>

      {status.gatekeeper.enabled && status.gatekeeper.cutoff ? (
        <p className="gatekeeper-cutoff">
          Screening mail that arrived after {new Date(status.gatekeeper.cutoff).toLocaleString()}.{" "}
          {status.approvedCount} sender{status.approvedCount === 1 ? "" : "s"} already approved.
        </p>
      ) : null}

      {message && <p role="status">{message}</p>}

      {status.gatekeeper.enabled ? (
        confirmingReset ? (
          <p className="gatekeeper-reset-confirm" role="alert">
            This clears every Verdict and re-seeds from Sent history — not reversible.{" "}
            <button type="button" onClick={() => void handleReset()} disabled={busy}>
              Confirm reset
            </button>
            <button type="button" onClick={() => setConfirmingReset(false)}>
              Cancel
            </button>
          </p>
        ) : (
          <button type="button" onClick={() => setConfirmingReset(true)} disabled={busy}>
            Reset Gatekeeper
          </button>
        )
      ) : null}

      <div className="gatekeeper-blocked">
        <h5>Blocked Senders</h5>
        {blocked.length === 0 ? (
          <p>No blocked senders.</p>
        ) : (
          <ul>
            {blocked.map((sender) => (
              <li key={senderKey(sender)}>
                <span>
                  {sender.value}
                  {/* Spam (#102): the one Block that also speaks to the provider's filter (ADR-0008 amendment) — named here so "why is this in Junk?" is answerable from the same list. */}
                  {sender.spam ? <span className="gatekeeper-blocked-spam"> · Spam</span> : null}
                </span>
                <button
                  type="button"
                  onClick={() => unblock({ scope: sender.scope, value: sender.value })}
                >
                  Unblock
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

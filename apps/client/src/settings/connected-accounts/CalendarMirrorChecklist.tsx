import type { Calendar } from "@mail/shared";
import { useState } from "react";
import { fetchUnmirrorImpact, mirrorCalendar, unmirrorCalendar } from "../../api/calendars.js";
import { Button } from "../../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog.js";
import { useCalendarsForConnectedAccount } from "../../store/calendars.js";

/**
 * The Calendar Facet cell's own selective-sync checklist (#235, the
 * #172-prototype-locked home for it: "the checklist lives in the Calendar
 * Facet cell's Popover on the Connected Accounts page"). This component is
 * that checklist's whole implementation — **not yet mounted anywhere**: the
 * Popover it belongs inside, and the Connected Accounts settings page
 * around it, are #201/#206's (`feat/connected-accounts`, not merged onto
 * this branch's ancestry — see this ticket's closing comment, the same
 * "seam ready, no host to plug it into yet" deferral #234's closing comment
 * made for its own credential provider). Exported so `apps/client/src/settings`
 * can drop `<CalendarMirrorChecklist connectedAccountId={...} />` straight
 * into that Popover's content the moment it lands.
 *
 * Every discovered Calendar gets a row here whether mirrored or not (this
 * ticket's own acceptance line) — `useCalendarsForConnectedAccount` already
 * reads free-busy-only calendars out of existence at the source
 * (`calendar-list-sync.ts` never rows one), so there is nothing to filter
 * out a second time here.
 *
 * Checking a box back on is a plain, harmless `mirrorCalendar` call.
 * Unchecking one is never optimistic (this ticket's own acceptance line:
 * "Not an Optimistic Action") — it opens `unmirror-impact`'s counts in a
 * confirm Dialog first, and the row's own checked state only ever reflects
 * what the Local Cache actually holds, never a local prediction; the
 * `pendingId` state below only disables the row mid-request so a second
 * click can't race the first.
 */
export function CalendarMirrorChecklist({ connectedAccountId }: { connectedAccountId: string }) {
  const calendars = useCalendarsForConnectedAccount(connectedAccountId);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<Calendar | null>(null);
  const [confirmCount, setConfirmCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleCheck(calendar: Calendar) {
    setError(null);
    setPendingId(calendar.id);
    try {
      await mirrorCalendar(calendar.id);
    } catch {
      setError(`Couldn't mirror "${calendar.name}" — try again.`);
    } finally {
      setPendingId(null);
    }
  }

  async function handleUncheck(calendar: Calendar) {
    setError(null);
    try {
      const { discarded } = await fetchUnmirrorImpact(calendar.id);
      setConfirmTarget(calendar);
      setConfirmCount(discarded.events);
    } catch {
      setError(`Couldn't check "${calendar.name}"'s sync status — try again.`);
    }
  }

  async function confirmUnmirror() {
    if (!confirmTarget) return;
    const calendar = confirmTarget;
    setPendingId(calendar.id);
    setConfirmTarget(null);
    setConfirmCount(null);
    try {
      await unmirrorCalendar(calendar.id);
    } catch {
      setError(`Couldn't stop mirroring "${calendar.name}" — try again.`);
    } finally {
      setPendingId(null);
    }
  }

  if (calendars === undefined) return null;

  return (
    <div className="flex flex-col gap-1.5">
      {calendars.length === 0 && (
        <p className="text-sm text-muted-foreground">No calendars found on this account.</p>
      )}
      {calendars.map((calendar) => (
        <label
          key={calendar.id}
          className="flex items-center gap-2 text-sm"
          htmlFor={`mirror-${calendar.id}`}
        >
          <input
            id={`mirror-${calendar.id}`}
            type="checkbox"
            checked={calendar.mirrored}
            disabled={pendingId === calendar.id}
            onChange={(event) => {
              if (event.target.checked) void handleCheck(calendar);
              else void handleUncheck(calendar);
            }}
          />
          <span
            aria-hidden
            className="inline-block h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: calendar.color }}
          />
          {calendar.name}
        </label>
      ))}
      {error && <p className="text-sm text-destructive">{error}</p>}

      <Dialog
        open={confirmTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setConfirmTarget(null);
            setConfirmCount(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Stop mirroring "{confirmTarget?.name}"?</DialogTitle>
            <DialogDescription>
              {confirmCount === 0
                ? "This calendar has no events synced yet."
                : `This discards ${confirmCount} synced ${confirmCount === 1 ? "event" : "events"} immediately. This can't be undone — the calendar itself stays here and can be re-mirrored later.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmTarget(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void confirmUnmirror()}>
              Stop mirroring
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

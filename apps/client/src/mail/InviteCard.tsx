import type { InvitationCard as InvitationCardData } from "@mail/shared";
import { AlertTriangle, CalendarClock } from "lucide-react";
import { useState } from "react";
import {
  addInvitationToCalendar,
  answerInvitation,
  answerLocalInvitation,
  cancelLocalReply,
} from "../api/invitations.js";
import { useCalendars } from "../store/calendars.js";
import { useEventsForRange } from "../store/events.js";
import { moveSeries, newSeriesId } from "../store/series.js";
import { announceUndoableAction } from "./undo-toast.js";

type ResponseStatus = "needsAction" | "accepted" | "declined" | "tentative";
type Answerable = "accepted" | "declined" | "tentative";

const RESPONSE_LABEL: Record<ResponseStatus, string> = {
  needsAction: "No answer yet",
  accepted: "Accepted",
  declined: "Declined",
  tentative: "Maybe",
};

function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

/** Busy, not-cancelled Occurrences overlapping `[start, end)` on any of the User's own Calendars, excluding the Occurrence this very Invitation would materialize (this ticket's acceptance line: "any busy, not-declined Occurrence on any Calendar, hidden ones included"). Fetched on demand outside the Event Window, computed in the Client inside it — both the same `useEventsForRange` call already gives every other range read on the grid. */
function useConflictCount(
  start: string | null,
  end: string | null,
  excludeSeriesId: string | null,
) {
  const { events } = useEventsForRange(start ?? "", end ?? "");
  if (!start || !end) return null;
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  return events.filter((event) => {
    if (event.seriesId === excludeSeriesId) return false;
    if (event.status === "cancelled") return false;
    if (event.transparency === "transparent") return false;
    return new Date(event.start).getTime() < endMs && new Date(event.end).getTime() > startMs;
  }).length;
}

/**
 * The Reader's invite card (#240, #241, ADR-0027): one per Thread per `UID`,
 * its highest-`SEQUENCE` revision, pinned above `MessageList` in
 * `ThreadDetailPane`. Three Answer postures, by `card.match`:
 *
 * - `synced` — an Event on a Connected Account's mirrored Calendar (#240):
 *   Accept/Maybe/Decline is an Event edit the upstream turns into its own
 *   `REPLY`.
 * - not `synced` but `isAttendee` (#241) — the Local fallback: the same
 *   three buttons, but the Answer queues an iMIP `REPLY` through the invited
 *   Mail Account's own SMTP, and a picker lets the User move the Event to a
 *   different Local Calendar first.
 * - no match at all, `offerAddToCalendar` (#241) — an Invitation naming
 *   nobody the User is: "Add to calendar" alone, never an Answer (Wicket
 *   never answers as an address the User does not own).
 */
export function InviteCard({ card, threadId }: { card: InvitationCardData; threadId: string }) {
  const [myStatus, setMyStatus] = useState<ResponseStatus>(
    card.match?.myResponseStatus ?? "needsAction",
  );
  const [pending, setPending] = useState<Answerable | null>(null);
  const [activeSeriesId, setActiveSeriesId] = useState<string | null>(card.match?.seriesId ?? null);
  const [activeCalendarId, setActiveCalendarId] = useState<string | null>(
    card.match?.calendarId ?? null,
  );
  const [added, setAdded] = useState(false);

  const calendars = useCalendars();
  const localCalendars = calendars?.filter((calendar) => calendar.origin.type === "local") ?? [];

  const cancelled = card.kind === "cancellation" || card.match?.cancelled === true;
  const title = card.vevent?.title || "(no title)";
  const when = formatWhen(
    card.vevent?.start ?? null,
    card.vevent?.end ?? null,
    card.vevent?.allDay ?? false,
  );

  const conflicts = useConflictCount(
    card.vevent?.start ?? null,
    card.vevent?.end ?? null,
    activeSeriesId,
  );

  const caution =
    card.fromAddress &&
    card.organizer?.address &&
    normalizeAddress(card.fromAddress) !== normalizeAddress(card.organizer.address);

  async function answer(responseStatus: Answerable) {
    if (!activeSeriesId || pending) return;
    const seriesId = activeSeriesId;
    const previous = myStatus;
    setPending(responseStatus);
    try {
      const result = await answerInvitation(seriesId, responseStatus);
      setMyStatus(responseStatus);
      // No Undo for a first Answer (ADR-0027): neither Google nor Graph's
      // `REPLY` shape can express "needsAction" back upstream.
      if (result.previousResponseStatus !== "needsAction" && result.previousResponseStatus) {
        const undoTo = result.previousResponseStatus;
        announceUndoableAction("invitationAnswer", () => {
          setMyStatus(undoTo);
          void answerInvitation(seriesId, undoTo as Answerable);
        });
      }
    } catch {
      setMyStatus(previous);
    } finally {
      setPending(null);
    }
  }

  /** The Local fallback's own Answer (#241): a queued `REPLY`, not an Event edit — Undo is a true cancel of the send, not a second Answer. */
  async function answerLocal(responseStatus: Answerable) {
    if (!activeSeriesId || pending) return;
    const seriesId = activeSeriesId;
    const previous = myStatus;
    setPending(responseStatus);
    try {
      const result = await answerLocalInvitation(seriesId, responseStatus);
      setMyStatus(responseStatus);
      const replyId = result.replyId;
      announceUndoableAction("invitationAnswer", () => {
        setMyStatus(previous);
        void cancelLocalReply(replyId, previous);
      });
    } catch {
      setMyStatus(previous);
    } finally {
      setPending(null);
    }
  }

  function moveToCalendar(targetCalendarId: string) {
    if (!activeSeriesId || targetCalendarId === activeCalendarId) return;
    const movedSeriesId = newSeriesId();
    void moveSeries(activeSeriesId, movedSeriesId, targetCalendarId);
    setActiveSeriesId(movedSeriesId);
    setActiveCalendarId(targetCalendarId);
  }

  async function addToCalendar() {
    try {
      await addInvitationToCalendar(threadId, card.uid);
      setAdded(true);
    } catch {
      // Left un-added; the button stays for a retry.
    }
  }

  const isLocalAnswerable = card.match !== null && !card.match.synced && card.match.isAttendee;

  return (
    <section className="invite-card" aria-label="Invitation">
      <div className="invite-card-head">
        <CalendarClock size={16} />
        <div className="invite-card-heading">
          <div className="invite-card-title">{title}</div>
          {when ? <div className="invite-card-when">{when}</div> : null}
        </div>
      </div>

      {caution ? (
        <div className="invite-card-caution">
          <AlertTriangle size={13} />
          <span>
            Sent from {card.fromAddress}, not the organiser ({card.organizer?.address})
          </span>
        </div>
      ) : null}

      {cancelled ? (
        <div className="invite-card-cancelled">Cancelled by the organiser</div>
      ) : card.match?.synced ? (
        <>
          <div className="invite-card-status">
            {RESPONSE_LABEL[myStatus]}
            {typeof conflicts === "number" && conflicts > 0 ? (
              <span className="invite-card-conflicts">
                {conflicts} conflict{conflicts === 1 ? "" : "s"}
              </span>
            ) : null}
          </div>
          <div className="invite-card-actions">
            <button
              type="button"
              className={myStatus === "accepted" ? "on" : ""}
              disabled={pending !== null}
              onClick={() => answer("accepted")}
            >
              Accept
            </button>
            <button
              type="button"
              className={myStatus === "tentative" ? "on" : ""}
              disabled={pending !== null}
              onClick={() => answer("tentative")}
            >
              Maybe
            </button>
            <button
              type="button"
              className={myStatus === "declined" ? "on" : ""}
              disabled={pending !== null}
              onClick={() => answer("declined")}
            >
              Decline
            </button>
          </div>
        </>
      ) : isLocalAnswerable ? (
        <>
          <div className="invite-card-status">
            {RESPONSE_LABEL[myStatus]}
            {typeof conflicts === "number" && conflicts > 0 ? (
              <span className="invite-card-conflicts">
                {conflicts} conflict{conflicts === 1 ? "" : "s"}
              </span>
            ) : null}
          </div>
          {localCalendars.length > 1 ? (
            <select
              aria-label="Calendar"
              value={activeCalendarId ?? ""}
              onChange={(event) => moveToCalendar(event.target.value)}
              disabled={pending !== null}
            >
              {localCalendars.map((calendar) => (
                <option key={calendar.id} value={calendar.id}>
                  {calendar.name}
                </option>
              ))}
            </select>
          ) : null}
          <div className="invite-card-actions">
            <button
              type="button"
              className={myStatus === "accepted" ? "on" : ""}
              disabled={pending !== null}
              onClick={() => answerLocal("accepted")}
            >
              Accept
            </button>
            <button
              type="button"
              className={myStatus === "tentative" ? "on" : ""}
              disabled={pending !== null}
              onClick={() => answerLocal("tentative")}
            >
              Maybe
            </button>
            <button
              type="button"
              className={myStatus === "declined" ? "on" : ""}
              disabled={pending !== null}
              onClick={() => answerLocal("declined")}
            >
              Decline
            </button>
          </div>
        </>
      ) : card.match ? (
        <div className="invite-card-note">Answering from a Local Calendar isn't available yet.</div>
      ) : card.offerAddToCalendar ? (
        added ? (
          <div className="invite-card-note">Added to calendar.</div>
        ) : (
          <button type="button" onClick={() => void addToCalendar()}>
            Add to calendar
          </button>
        )
      ) : (
        <div className="invite-card-note">Not yet on any of your Calendars.</div>
      )}
    </section>
  );
}

function formatWhen(start: string | null, end: string | null, allDay: boolean): string | null {
  if (!start) return null;
  const startDate = new Date(start);
  const dateFormat: Intl.DateTimeFormatOptions = {
    weekday: "short",
    month: "short",
    day: "numeric",
  };
  const timeFormat: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
  if (allDay) return startDate.toLocaleDateString(undefined, dateFormat);
  const datePart = startDate.toLocaleDateString(undefined, dateFormat);
  const startTime = startDate.toLocaleTimeString(undefined, timeFormat);
  const endTime = end ? new Date(end).toLocaleTimeString(undefined, timeFormat) : null;
  return endTime ? `${datePart} · ${startTime}–${endTime}` : `${datePart} · ${startTime}`;
}

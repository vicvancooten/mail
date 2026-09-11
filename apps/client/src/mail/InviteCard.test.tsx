import type { InvitationCard as InvitationCardData } from "@mail/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as invitationsApi from "../api/invitations.js";
import { InviteCard } from "./InviteCard.js";
import { resetUndoToastsForTest } from "./undo-toast.js";

vi.mock("../api/invitations.js", () => ({
  answerInvitation: vi.fn(),
  answerLocalInvitation: vi.fn(),
  cancelLocalReply: vi.fn(),
  addInvitationToCalendar: vi.fn(),
}));

vi.mock("../store/events.js", () => ({
  useEventsForRange: vi.fn(() => ({ events: [], outsideWindow: false, window: null })),
}));

vi.mock("../store/calendars.js", () => ({
  useCalendars: vi.fn(() => []),
}));

vi.mock("../store/series.js", () => ({
  moveSeries: vi.fn(),
  newSeriesId: vi.fn(() => "moved-series-1"),
}));

interface ToastCallOptions {
  id: string;
  duration: number;
  action?: { label: string; onClick: () => void };
}
const toastCalls: [string, ToastCallOptions][] = [];
vi.mock("sonner", () => ({
  toast: Object.assign(
    (message: string, opts: ToastCallOptions) => toastCalls.push([message, opts]),
    { dismiss: () => {} },
  ),
}));

/** The most recently raised toast for one `id` — `screener-integration.test.tsx`'s own helper, same shape. */
function lastToastFor(id: string): ToastCallOptions {
  const call = [...toastCalls].reverse().find(([, opts]) => opts.id === id);
  if (!call) throw new Error(`no toast raised for ${id}`);
  return call[1];
}

beforeEach(() => {
  vi.clearAllMocks();
  toastCalls.length = 0;
  resetUndoToastsForTest();
});

afterEach(() => {
  cleanup();
});

function baseCard(overrides: Partial<InvitationCardData> = {}): InvitationCardData {
  return {
    uid: "uid-1",
    kind: "request",
    sequence: 0,
    dtstamp: "2026-01-01T00:00:00.000Z",
    organizer: { name: "Organiser", address: "organiser@example.com", role: null, partstat: null },
    attendees: [],
    vevent: {
      title: "Standup",
      description: null,
      location: null,
      start: "2026-01-05T09:00:00.000Z",
      end: "2026-01-05T09:30:00.000Z",
      allDay: false,
      tzid: "UTC",
      status: "CONFIRMED",
    },
    fromAddress: "organiser@example.com",
    match: null,
    offerAddToCalendar: false,
    ...overrides,
  };
}

describe("InviteCard", () => {
  it("renders the title and no Answer buttons when there is no matching Series yet", () => {
    render(<InviteCard card={baseCard()} threadId="thread-1" />);
    expect(screen.getByText("Standup")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
    expect(screen.getByText("Not yet on any of your Calendars.")).toBeDefined();
  });

  it("offers Add to calendar for an Invitation addressed to nobody the User is", async () => {
    vi.mocked(invitationsApi.addInvitationToCalendar).mockResolvedValue({ ok: true });
    render(<InviteCard card={baseCard({ offerAddToCalendar: true })} threadId="thread-1" />);

    fireEvent.click(screen.getByRole("button", { name: "Add to calendar" }));
    await screen.findByText("Added to calendar.");

    expect(invitationsApi.addInvitationToCalendar).toHaveBeenCalledWith("thread-1", "uid-1");
  });

  it("shows a quiet note, no buttons, for a Local Calendar match with no Attendee entry of the User's own", () => {
    render(
      <InviteCard
        card={baseCard({
          match: {
            calendarId: "local:1",
            seriesId: "series-1",
            synced: false,
            cancelled: false,
            selfEmail: "me@example.com",
            myResponseStatus: "needsAction",
            isAttendee: false,
          },
        })}
        threadId="thread-1"
      />,
    );
    expect(screen.getByText(/isn't available yet/)).toBeDefined();
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
  });

  it("offers Accept/Maybe/Decline for a Local Calendar match the User is an Attendee on (#241)", async () => {
    vi.mocked(invitationsApi.answerLocalInvitation).mockResolvedValue({
      ok: true,
      previousResponseStatus: "needsAction",
      replyId: "reply-1",
    });
    render(
      <InviteCard
        card={baseCard({
          match: {
            calendarId: "local:1",
            seriesId: "series-1",
            synced: false,
            cancelled: false,
            selfEmail: "me@example.com",
            myResponseStatus: "needsAction",
            isAttendee: true,
          },
        })}
        threadId="thread-1"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await screen.findByText("Accepted");

    expect(invitationsApi.answerLocalInvitation).toHaveBeenCalledWith("series-1", "accepted");
  });

  it("offers Accept/Maybe/Decline for a synced Calendar match, highlighting the current Answer", () => {
    render(
      <InviteCard
        card={baseCard({
          match: {
            calendarId: "gcal:1:x",
            seriesId: "series-1",
            synced: true,
            cancelled: false,
            selfEmail: "me@example.com",
            myResponseStatus: "tentative",
            isAttendee: true,
          },
        })}
        threadId="thread-1"
      />,
    );
    expect(screen.getByRole("button", { name: "Accept" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Maybe" }).className).toContain("on");
  });

  it("shows a quiet caution line when From differs from the organiser", () => {
    render(
      <InviteCard
        card={baseCard({
          fromAddress: "someone-else@example.com",
          match: {
            calendarId: "gcal:1:x",
            seriesId: "series-1",
            synced: true,
            cancelled: false,
            selfEmail: "me@example.com",
            myResponseStatus: "needsAction",
            isAttendee: true,
          },
        })}
        threadId="thread-1"
      />,
    );
    expect(screen.getByText(/not the organiser/)).toBeDefined();
  });

  it("reads 'Cancelled by the organiser' for a cancellation, with no Answer buttons", () => {
    render(
      <InviteCard
        card={baseCard({
          kind: "cancellation",
          match: {
            calendarId: "gcal:1:x",
            seriesId: "series-1",
            synced: true,
            cancelled: true,
            selfEmail: "me@example.com",
            myResponseStatus: "accepted",
            isAttendee: true,
          },
        })}
        threadId="thread-1"
      />,
    );
    expect(screen.getByText("Cancelled by the organiser")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
  });

  it("answering calls the API, updates the highlighted button, and offers Undo — except for a first Answer", async () => {
    vi.mocked(invitationsApi.answerInvitation).mockResolvedValue({
      ok: true,
      previousResponseStatus: "needsAction",
    });
    render(
      <InviteCard
        card={baseCard({
          match: {
            calendarId: "gcal:1:x",
            seriesId: "series-1",
            synced: true,
            cancelled: false,
            selfEmail: "me@example.com",
            myResponseStatus: "needsAction",
            isAttendee: true,
          },
        })}
        threadId="thread-1"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await screen.findByText("Accepted");

    expect(invitationsApi.answerInvitation).toHaveBeenCalledWith("series-1", "accepted");
    // A first Answer (previous was "needsAction") offers no Undo.
    expect(toastCalls).toHaveLength(0);
  });

  it("a later Answer offers Undo, which answers again with the previous value", async () => {
    vi.mocked(invitationsApi.answerInvitation).mockResolvedValue({
      ok: true,
      previousResponseStatus: "tentative",
    });
    render(
      <InviteCard
        card={baseCard({
          match: {
            calendarId: "gcal:1:x",
            seriesId: "series-1",
            synced: true,
            cancelled: false,
            selfEmail: "me@example.com",
            myResponseStatus: "tentative",
            isAttendee: true,
          },
        })}
        threadId="thread-1"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    await screen.findByText("Declined");

    const toast = lastToastFor("undo-toast-invitationAnswer");
    toast.action?.onClick();

    expect(invitationsApi.answerInvitation).toHaveBeenLastCalledWith("series-1", "tentative");
    // myStatus reverted — "Maybe" re-highlighted, "Decline" no longer is.
    await screen.findByText("Maybe");
    expect(screen.getByRole("button", { name: "Maybe" }).className).toContain("on");
    expect(screen.getByRole("button", { name: "Decline" }).className).not.toContain("on");
  });

  it("a Local Answer's Undo cancels the queued Reply outright rather than sending a new one", async () => {
    vi.mocked(invitationsApi.answerLocalInvitation).mockResolvedValue({
      ok: true,
      previousResponseStatus: "needsAction",
      replyId: "reply-1",
    });
    render(
      <InviteCard
        card={baseCard({
          match: {
            calendarId: "local:1",
            seriesId: "series-1",
            synced: false,
            cancelled: false,
            selfEmail: "me@example.com",
            myResponseStatus: "needsAction",
            isAttendee: true,
          },
        })}
        threadId="thread-1"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    await screen.findByText("Declined");

    const toast = lastToastFor("undo-toast-invitationAnswer");
    toast.action?.onClick();

    expect(invitationsApi.cancelLocalReply).toHaveBeenCalledWith("reply-1", "needsAction");
    expect(invitationsApi.answerLocalInvitation).toHaveBeenCalledTimes(1);
    await screen.findByText("No answer yet");
  });
});

import { z } from "zod";
import { seriesAttendeeSchema } from "./series.js";

/**
 * The Reader's invite card (#240, ADR-0027): what `GET /threads/:threadId
 * /invitations` hands the Client for every distinct `UID` an Invitation
 * (#239) names in that Thread — the highest-`SEQUENCE`/`DTSTAMP` revision
 * only, per `invitations/store.ts#latestInvitationRevisionsForThread`. The
 * Client never parses iCalendar itself (ADR-0025), so this is already
 * flattened to exactly what a card renders: no raw `VEVENT`, no MIME.
 */
export const invitationParticipantSchema = z.object({
  name: z.string().nullable(),
  address: z.string(),
  role: z.string().nullable(),
  partstat: z.string().nullable(),
});
export type InvitationParticipant = z.infer<typeof invitationParticipantSchema>;

export const invitationVeventSchema = z.object({
  title: z.string().nullable(),
  description: z.string().nullable(),
  location: z.string().nullable(),
  start: z.string().nullable(),
  end: z.string().nullable(),
  allDay: z.boolean(),
  tzid: z.string().nullable(),
  status: z.string().nullable(),
});
export type InvitationCardVevent = z.infer<typeof invitationVeventSchema>;

/**
 * Where this Invitation's `UID` matches a Series on one of the User's own
 * Calendars — the only case this ticket answers into (ADR-0027: "this slice
 * covers the synced, upstream-scheduled path only"). `synced` is `false`
 * for a Local Calendar match (#241's own path, no Answer button here);
 * `myResponseStatus`/`selfEmail` are `null` when the Series carries no
 * attendee for the address this Invitation arrived at yet.
 */
export const invitationMatchSchema = z.object({
  calendarId: z.string(),
  seriesId: z.string(),
  synced: z.boolean(),
  /** Any Occurrence upstream marked `cancelled`, or the Series itself soft-deleted — "Cancelled by the organiser" (this ticket's acceptance line). */
  cancelled: z.boolean(),
  selfEmail: z.string().nullable(),
  myResponseStatus: seriesAttendeeSchema.shape.responseStatus.nullable(),
  /**
   * Whether the invited address actually names this Series' own Attendee
   * entry (#241, ADR-0027) — `false` for a forwarded Invitation nobody the
   * User is was named on, where the card offers "Add to calendar" alone,
   * never an Answer (Wicket never answers as an address the User does not
   * own). Always `true` on a synced match: #240's own card never surfaces
   * a Series it didn't find an Attendee entry for.
   */
  isAttendee: z.boolean(),
});
export type InvitationMatch = z.infer<typeof invitationMatchSchema>;

export const invitationCardSchema = z.object({
  uid: z.string(),
  kind: z.enum(["request", "answer", "cancellation"]),
  sequence: z.number().int(),
  dtstamp: z.iso.datetime(),
  organizer: invitationParticipantSchema.nullable(),
  attendees: z.array(invitationParticipantSchema),
  vevent: invitationVeventSchema.nullable(),
  /** The arriving Message's own `From` — compared against `organizer` for the card's quiet caution line (nothing on the wire authenticates a difference, ADR-0027). */
  fromAddress: z.string().nullable(),
  match: invitationMatchSchema.nullable(),
  /**
   * `match: null` and this Invitation names nobody the User is (#241,
   * ADR-0027) — the card offers "Add to calendar", a private copy on the
   * Local fallback Calendar, rather than the "Not yet on any of your
   * Calendars" wait-and-see note a synced Invitation's poll lag still gets.
   */
  offerAddToCalendar: z.boolean(),
});
export type InvitationCard = z.infer<typeof invitationCardSchema>;

export const invitationCardsResponseSchema = z.object({
  cards: z.array(invitationCardSchema),
});
export type InvitationCardsResponse = z.infer<typeof invitationCardsResponseSchema>;

/** `POST /calendars/series/:seriesId/answer` — an Event edit on a synced Calendar (ADR-0027), never offered for a Local-Calendar match (#241). */
export const answerInvitationRequestSchema = z.object({
  responseStatus: z.enum(["accepted", "declined", "tentative"]),
});
export type AnswerInvitationRequest = z.infer<typeof answerInvitationRequestSchema>;

export const answerInvitationResponseSchema = z.object({
  ok: z.literal(true),
  /**
   * What the Series' own attendee entry held before this Answer —
   * `"needsAction"` (a first Answer) is the one value Undo cannot express
   * back upstream (Google has no `NEEDS-ACTION` `REPLY`, Graph has no
   * un-respond, ADR-0027), so the Client offers no Undo for it.
   */
  previousResponseStatus: seriesAttendeeSchema.shape.responseStatus.nullable(),
});
export type AnswerInvitationResponse = z.infer<typeof answerInvitationResponseSchema>;

/**
 * `POST /calendars/series/:seriesId/answer-local` (#241, ADR-0027): the
 * Local-fallback complement to `answerInvitationRequestSchema` above — same
 * request shape, a different Answer entirely (an iMIP `REPLY` queued
 * through the invited Mail Account's own SMTP, never an Event edit an
 * upstream turns into one).
 */
export const answerLocalInvitationRequestSchema = z.object({
  responseStatus: z.enum(["accepted", "declined", "tentative"]),
});
export type AnswerLocalInvitationRequest = z.infer<typeof answerLocalInvitationRequestSchema>;

export const answerLocalInvitationResponseSchema = z.object({
  ok: z.literal(true),
  previousResponseStatus: seriesAttendeeSchema.shape.responseStatus.nullable(),
  /** The queued `imip_replies` row's id — what `POST /calendars/replies/:replyId/cancel-send` names for Undo. */
  replyId: z.string(),
});
export type AnswerLocalInvitationResponse = z.infer<typeof answerLocalInvitationResponseSchema>;

/** `POST /calendars/replies/:replyId/cancel-send` — Undo Send for a queued `REPLY` (ADR-0007, ADR-0027: "Undo cancels it outright"). */
export const cancelLocalReplyRequestSchema = z.object({
  previousResponseStatus: seriesAttendeeSchema.shape.responseStatus,
});
export type CancelLocalReplyRequest = z.infer<typeof cancelLocalReplyRequestSchema>;

export const cancelLocalReplyResponseSchema = z.object({ ok: z.literal(true) });
export type CancelLocalReplyResponse = z.infer<typeof cancelLocalReplyResponseSchema>;

/** `POST /threads/:threadId/invitations/:uid/add-to-calendar` — "Add to calendar" (#241, ADR-0027): a private copy of an Invitation addressed to nobody the User is. */
export const addInvitationToCalendarResponseSchema = z.object({ ok: z.literal(true) });
export type AddInvitationToCalendarResponse = z.infer<typeof addInvitationToCalendarResponseSchema>;

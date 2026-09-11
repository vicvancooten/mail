import {
  type AddInvitationToCalendarResponse,
  type AnswerInvitationResponse,
  type AnswerLocalInvitationResponse,
  addInvitationToCalendarResponseSchema,
  answerInvitationResponseSchema,
  answerLocalInvitationResponseSchema,
  type CancelLocalReplyResponse,
  cancelLocalReplyResponseSchema,
  type InvitationCardsResponse,
  invitationCardsResponseSchema,
  type SeriesAttendee,
} from "@mail/shared";
import { getJson, postJson } from "./auth.js";

/** The Reader's invite card (#240): a plain fetch-through read, the same posture `fetchThreadMessages` already takes for a Thread's Messages — an Invitation is not a synced collection (`db/schema.ts#invitations`'s own doc comment). */
export function fetchInvitationCards(threadId: string): Promise<InvitationCardsResponse> {
  return getJson(`/threads/${threadId}/invitations`, (data) =>
    invitationCardsResponseSchema.parse(data),
  );
}

/** An Answer on a synced Calendar (#240, ADR-0027): an Event edit through the write-back outbox, the upstream sends the `REPLY`. */
export function answerInvitation(
  seriesId: string,
  responseStatus: "accepted" | "declined" | "tentative",
): Promise<AnswerInvitationResponse> {
  return postJson(`/calendars/series/${seriesId}/answer`, { responseStatus }, (data) =>
    answerInvitationResponseSchema.parse(data),
  );
}

/** An Answer on a Local Calendar (#241, ADR-0027): queues an iMIP `REPLY` through the invited Mail Account's own SMTP, held for the Undo Send delay. */
export function answerLocalInvitation(
  seriesId: string,
  responseStatus: "accepted" | "declined" | "tentative",
): Promise<AnswerLocalInvitationResponse> {
  return postJson(`/calendars/series/${seriesId}/answer-local`, { responseStatus }, (data) =>
    answerLocalInvitationResponseSchema.parse(data),
  );
}

/** Undo Send for a queued `REPLY` (#241, ADR-0007): a true cancel, never a second Answer. */
export function cancelLocalReply(
  replyId: string,
  previousResponseStatus: SeriesAttendee["responseStatus"],
): Promise<CancelLocalReplyResponse> {
  return postJson(`/calendars/replies/${replyId}/cancel-send`, { previousResponseStatus }, (data) =>
    cancelLocalReplyResponseSchema.parse(data),
  );
}

/** "Add to calendar" (#241, ADR-0027): a private copy of an Invitation addressed to nobody the User is. */
export function addInvitationToCalendar(
  threadId: string,
  uid: string,
): Promise<AddInvitationToCalendarResponse> {
  return postJson(
    `/threads/${threadId}/invitations/${encodeURIComponent(uid)}/add-to-calendar`,
    {},
    (data) => addInvitationToCalendarResponseSchema.parse(data),
  );
}

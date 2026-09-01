import { type SendSettings, sendSettingsSchema, type UndoSendDelaySeconds } from "@mail/shared";
import { getJson, patchJson } from "./auth.js";

/**
 * The Undo Send delay (#46, ADR-0007). A plain authenticated GET/PATCH rather
 * than a synced collection: #54 owns preference sync, and this is the one
 * value the send path needs before that lands (see
 * `routes/send-settings.ts`).
 *
 * The Client reads this only to *describe* the window — "Undo: 10s" on the
 * send control — never to run a timer. `submit_after` is the server's, per
 * ADR-0007's "measured from server receipt, never from the Client's clock".
 */
export function fetchSendSettings(): Promise<SendSettings> {
  return getJson("/send-settings", (data) => sendSettingsSchema.parse(data));
}

export function updateSendSettings(
  undoSendDelaySeconds: UndoSendDelaySeconds,
): Promise<SendSettings> {
  return patchJson("/send-settings", { undoSendDelaySeconds }, (data) =>
    sendSettingsSchema.parse(data),
  );
}

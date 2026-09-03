import type { UndoSendDelaySeconds } from "@mail/shared";
import { DEFAULT_UNDO_SEND_DELAY_SECONDS, UNDO_SEND_DELAY_OPTIONS } from "@mail/shared";
import { Send } from "lucide-react";
import { useCallback } from "react";
import { enqueueUserMutation, usePreference } from "../store/index.js";
import type { SendVerdict } from "./send-validation.js";

/**
 * The composer's send control: the button, whatever the current `SendVerdict`
 * (`send-validation.ts`) has it say, and the Undo Send window it will get.
 * Presentational — the verdict, the acknowledgement and the press handler are
 * the Composer's, so the button and `Cmd/Ctrl+Enter` share one code path.
 *
 * The delay picker reads and writes the User's own `Preference` (#54,
 * ADR-0011), so every device agrees about the window before it is used —
 * `usePreference()`'s Local Cache read rather than a network fetch, so it is
 * available offline from the first paint. The number shown is a
 * *description* of the window the Sync Backend will apply, never a timer
 * this component runs (ADR-0007: the delay is measured from server receipt).
 * `off` is offered as a real option and means a zero-length window, not a
 * different send path.
 */

export interface SendControlProps {
  verdict: SendVerdict;
  /** True once the User has pressed through a `warn` verdict — the next press sends. */
  acknowledged: boolean;
  onSend: () => void;
}

export function SendControl({ verdict, acknowledged, onSend }: SendControlProps) {
  const preference = usePreference();
  const delay = preference?.undoSendDelaySeconds ?? DEFAULT_UNDO_SEND_DELAY_SECONDS;

  const changeDelay = useCallback((seconds: UndoSendDelaySeconds) => {
    void enqueueUserMutation({ type: "setUndoSendDelay", undoSendDelaySeconds: seconds });
  }, []);

  const blocked = verdict.kind === "blocked";

  return (
    <div className="composer-send">
      <button
        type="button"
        className="composer-send-button"
        onClick={onSend}
        disabled={blocked}
        title={blocked ? verdict.reason : "Send (Cmd/Ctrl+Enter)"}
      >
        <Send size={14} />
        {label(verdict, acknowledged)}
      </button>
      <label className="composer-send-delay">
        Undo
        <select
          aria-label="Undo Send delay"
          value={delay}
          onChange={(event) => changeDelay(Number(event.target.value) as UndoSendDelaySeconds)}
        >
          {UNDO_SEND_DELAY_OPTIONS.map((seconds) => (
            <option key={seconds} value={seconds}>
              {seconds === 0 ? "off" : `${seconds}s`}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

/**
 * compose-spec's "warn once, then send", said on the button itself: the first
 * press turns the label into what is missing, the second sends. Deliberately
 * not a modal, and the label has to *change* on that first press or the press
 * reads as the button being broken.
 */
function label(verdict: SendVerdict, acknowledged: boolean): string {
  if (verdict.kind !== "warn") return "Send";
  return acknowledged ? "Send anyway" : verdict.reason;
}

import type { UndoSendDelaySeconds } from "@mail/shared";
import { UNDO_SEND_DELAY_OPTIONS } from "@mail/shared";
import { Send } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { fetchSendSettings, updateSendSettings } from "../api/send-settings.js";
import type { SendVerdict } from "./send-validation.js";

/**
 * The composer's send control: the button, whatever the current `SendVerdict`
 * (`send-validation.ts`) has it say, and the Undo Send window it will get.
 * Presentational — the verdict, the acknowledgement and the press handler are
 * the Composer's, so the button and `Cmd/Ctrl+Enter` share one code path.
 *
 * The delay picker reads and writes the User's own preference server-side, so
 * every device agrees about the window before it is used. The number shown is
 * a *description* of the window the Sync Backend will apply, never a timer
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
  const [delay, setDelay] = useState<UndoSendDelaySeconds | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchSendSettings()
      .then((settings) => {
        if (!cancelled) setDelay(settings.undoSendDelaySeconds);
      })
      // Silent when it fails: the window is the server's either way, and a
      // composer that cannot describe it must still be able to send.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const changeDelay = useCallback((seconds: UndoSendDelaySeconds) => {
    setDelay(seconds);
    void updateSendSettings(seconds).catch(() => {});
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
          value={delay ?? ""}
          disabled={delay === null}
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

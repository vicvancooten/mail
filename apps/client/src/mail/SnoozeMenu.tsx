import type { RegionFormatSettings } from "@mail/shared";
import { useState } from "react";
import type { CachedThread } from "../store/index.js";
import { formatSnoozeUntil, SNOOZE_PRESETS } from "./snooze-presets.js";

/**
 * The Snooze row cluster control's popover (#76): "a small set of preset
 * times plus a custom pick", opened from `ThreadRow`'s own Snooze button.
 * Same small-popover shape `LabelPicker` already has — a `role="menu"` list
 * plus one small form, closed on picking an option, submitting the custom
 * form, or Escape — deliberately not a shared component with `LabelPicker`:
 * the two pick fundamentally different things (a name vs. an instant) and
 * have nothing but the popover shell in common.
 *
 * Positioned by its caller, not itself (`ThreadRow.tsx`'s own `.snooze-menu`
 * rule) — this component only ever renders the menu's contents.
 */
export function SnoozeMenu({
  thread,
  onSnooze,
  onClose,
  region,
}: {
  thread: CachedThread;
  onSnooze: (until: string) => void;
  onClose: () => void;
  /** Region Settings (#304) — `formatSnoozeUntil`'s own locale/clock/zone for each preset's time and the custom picker's preview. Optional: a caller with no Region Settings read above it (most unit tests) keeps today's browser-default clock. */
  region?: Pick<RegionFormatSettings, "locale" | "clockFormat" | "timeZone">;
}) {
  const [customValue, setCustomValue] = useState("");
  const subjectLabel = thread.subject || "(no subject)";
  const now = new Date();
  const customParsed = customValue ? new Date(customValue) : null;
  const customPreview =
    customParsed && !Number.isNaN(customParsed.getTime())
      ? formatSnoozeUntil(customParsed, now, region)
      : null;

  function commit(until: Date) {
    onSnooze(until.toISOString());
    onClose();
  }

  function submitCustom() {
    if (!customParsed || Number.isNaN(customParsed.getTime())) return;
    commit(customParsed);
  }

  return (
    <div
      className="snooze-menu"
      role="menu"
      aria-label={`Snooze "${subjectLabel}"`}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <ul className="snooze-menu-list">
        {SNOOZE_PRESETS.map((preset) => (
          <li key={preset.label}>
            <button type="button" role="menuitem" onClick={() => commit(preset.until(new Date()))}>
              <span className="snooze-preset-label">{preset.label}</span>
              <span className="snooze-preset-time">
                {formatSnoozeUntil(preset.until(now), now, region)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <form
        className="snooze-menu-custom"
        onSubmit={(event) => {
          event.preventDefault();
          submitCustom();
        }}
      >
        <div className="snooze-menu-custom-field">
          <input
            type="datetime-local"
            value={customValue}
            onChange={(event) => setCustomValue(event.target.value)}
            aria-label="Custom snooze time"
          />
          {customPreview ? (
            <span className="snooze-menu-custom-preview">{customPreview}</span>
          ) : null}
        </div>
        <button type="submit" disabled={!customValue}>
          Snooze
        </button>
      </form>
    </div>
  );
}

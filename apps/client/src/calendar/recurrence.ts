/**
 * The recurrence editor's own subset (#233's own acceptance line: "The
 * recurrence editor offers only the subset every backend can express; an
 * untranslatable inbound rule is shown read-only"). A Local Calendar can
 * express any RFC 5545 RRULE (`LOCAL_CALENDAR_CAPABILITIES.recurrenceGrammar
 * === "rfc5545"`, `@mail/shared`), but this ticket's own editor only ever
 * *authors* five: None, Daily, Weekly, Monthly, Yearly, each at `INTERVAL=1`
 * with no `BYDAY`/`COUNT`/`UNTIL` of its own — a fuller by-day/interval
 * picker is real UI investment this ticket's closing report defers. A
 * Series whose `rrules` don't match one of these five exactly (an inbound
 * Series this editor didn't itself author) is shown read-only rather than
 * silently reinterpreted or clobbered on save.
 */
export const RECURRENCE_TEMPLATES = ["none", "daily", "weekly", "monthly", "yearly"] as const;
export type RecurrenceTemplate = (typeof RECURRENCE_TEMPLATES)[number];

const TEMPLATE_RRULES: Record<Exclude<RecurrenceTemplate, "none">, string> = {
  daily: "FREQ=DAILY",
  weekly: "FREQ=WEEKLY",
  monthly: "FREQ=MONTHLY",
  yearly: "FREQ=YEARLY",
};

/** Which of the five templates a Series' `rrules` matches, or `null` for anything else — the editor's read-only fallback. */
export function recurrenceTemplateFor(rrules: readonly string[]): RecurrenceTemplate | null {
  if (rrules.length === 0) return "none";
  if (rrules.length > 1) return null;
  const [rule] = rrules;
  const match = (Object.entries(TEMPLATE_RRULES) as [RecurrenceTemplate, string][]).find(
    ([, value]) => value === rule,
  );
  return match?.[0] ?? null;
}

/** The `rrules` array a template produces — `none` clears recurrence entirely. */
export function rrulesForTemplate(template: RecurrenceTemplate): string[] {
  return template === "none" ? [] : [TEMPLATE_RRULES[template]];
}

/** RFC 5545's DATE-TIME form for an `UNTIL` value: `YYYYMMDD` for an all-day/floating Series, `YYYYMMDDTHHMMSSZ` (always UTC per RFC 5545 §3.3.10) for a zoned one. */
function untilValue(instant: Date, dateOnly: boolean): string {
  const pad = (value: number, length = 2) => String(value).padStart(length, "0");
  if (dateOnly) {
    return `${pad(instant.getUTCFullYear(), 4)}${pad(instant.getUTCMonth() + 1)}${pad(instant.getUTCDate())}`;
  }
  return `${pad(instant.getUTCFullYear(), 4)}${pad(instant.getUTCMonth() + 1)}${pad(instant.getUTCDate())}T${pad(instant.getUTCHours())}${pad(instant.getUTCMinutes())}${pad(instant.getUTCSeconds())}Z`;
}

/**
 * "This and following" (#233's own acceptance line): caps the *old* Series'
 * recurrence at `untilInstant` — one intent, executed as the first of the
 * two writes the ticket's own body describes, the second being a brand-new
 * Series created from `untilInstant` onward with a new `UID`
 * (`EventEditorPopover.tsx`'s own split handler). Replaces any existing
 * `UNTIL`/`COUNT` on each rule (RFC 5545 forbids both together, and a stale
 * `COUNT` would otherwise keep generating instances past the new cutoff);
 * `[]` (no recurrence at all) stays `[]` — there is nothing to cap.
 */
export function withUntil(
  rrules: readonly string[],
  untilInstant: Date,
  dateOnly: boolean,
): string[] {
  const until = untilValue(untilInstant, dateOnly);
  return rrules.map((rule) => {
    const parts = rule
      .split(";")
      .filter((part) => !part.startsWith("UNTIL=") && !part.startsWith("COUNT="));
    parts.push(`UNTIL=${until}`);
    return parts.join(";");
  });
}

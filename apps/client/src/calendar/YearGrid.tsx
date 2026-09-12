import type { FirstDayOfWeek } from "@mail/shared";
import {
  type CivilDate,
  dayKey,
  daysInMonth,
  isoWeekday,
  isSameDay,
  monthLabel,
  startOfMonth,
  today,
} from "./calendar-dates.js";
import type { DayBucket } from "./calendar-occurrences.js";

/**
 * Year view: twelve mini-months (#231's own acceptance line) — clicking a
 * day jumps to Day view for that date, clicking the month heading jumps to
 * Month view for that month. No right-click zoom here (`CalendarDayCell`'s
 * own context menu is Month/Week/Work Week's own affordance): a mini-month
 * day is already one plain click away from Day view, so a second way to
 * reach it would just be redundant chrome.
 */
export function YearGrid({
  anchor,
  buckets,
  onOpenDay,
  onOpenMonth,
  firstDayOfWeek,
  locale,
}: {
  anchor: CivilDate;
  buckets: ReadonlyMap<string, DayBucket>;
  onOpenDay: (date: CivilDate) => void;
  onOpenMonth: (date: CivilDate) => void;
  /** First Day of the Week (#303) — each mini-month's own leading blanks. Default Monday, same as `calendar-dates.ts#isoWeekday`'s own default. */
  firstDayOfWeek?: FirstDayOfWeek;
  /** Region Settings' language and region (#303) — each mini-month's own heading. */
  locale?: string;
}) {
  const now = today();
  const months = Array.from({ length: 12 }, (_, index) =>
    startOfMonth({ year: anchor.year, month: index + 1, day: 1 }),
  );

  return (
    <div className="calendar-year-grid">
      {months.map((month) => (
        <MiniMonth
          key={dayKey(month)}
          month={month}
          now={now}
          buckets={buckets}
          onOpenDay={onOpenDay}
          onOpenMonth={onOpenMonth}
          firstDayOfWeek={firstDayOfWeek}
          locale={locale}
        />
      ))}
    </div>
  );
}

function MiniMonth({
  month,
  now,
  buckets,
  onOpenDay,
  onOpenMonth,
  firstDayOfWeek,
  locale,
}: {
  month: CivilDate;
  now: CivilDate;
  buckets: ReadonlyMap<string, DayBucket>;
  onOpenDay: (date: CivilDate) => void;
  onOpenMonth: (date: CivilDate) => void;
  firstDayOfWeek?: FirstDayOfWeek;
  locale?: string;
}) {
  const leadingBlanks = isoWeekday(month, firstDayOfWeek);
  const totalDays = daysInMonth(month);
  const monthKey = dayKey(month);
  const cells: { key: string; date: CivilDate | null }[] = [
    ...Array.from({ length: leadingBlanks }, (_, index) => ({
      key: `${monthKey}-blank-${index}`,
      date: null,
    })),
    ...Array.from({ length: totalDays }, (_, index) => ({
      key: `${monthKey}-${index}`,
      date: { ...month, day: index + 1 },
    })),
  ];

  return (
    <div className="calendar-mini-month">
      <button
        type="button"
        className="calendar-mini-month-heading"
        onClick={() => onOpenMonth(month)}
      >
        {monthLabel(month, locale)}
      </button>
      <div className="calendar-mini-month-grid">
        {cells.map(({ key, date }) =>
          date ? (
            <button
              key={key}
              type="button"
              className={[
                "calendar-mini-month-day",
                isSameDay(date, now) ? "today" : "",
                (buckets.get(dayKey(date))?.allDay.length ?? 0) +
                  (buckets.get(dayKey(date))?.timed.length ?? 0) >
                0
                  ? "has-events"
                  : "",
              ]
                .filter(Boolean)
                .join(" ")}
              onClick={() => onOpenDay(date)}
            >
              {date.day}
            </button>
          ) : (
            <span key={key} className="calendar-mini-month-day blank" aria-hidden="true" />
          ),
        )}
      </div>
    </div>
  );
}

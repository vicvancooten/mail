import { describe, expect, it } from "vitest";
import {
  addLocalDays,
  dateOnlyToWireDueDate,
  dueBucket,
  formatDueDate,
  formatDueTime,
  isOverdue,
  localDateInputValue,
  wireDueDateToDateInputValue,
} from "./task-due.js";

describe("dateOnlyToWireDueDate / wireDueDateToDateInputValue", () => {
  it("round-trips a Y-M-D day through the wire's UTC-midnight encoding", () => {
    const wire = dateOnlyToWireDueDate("2026-06-15");
    expect(wire).toBe("2026-06-15T00:00:00.000Z");
    expect(wireDueDateToDateInputValue(wire)).toBe("2026-06-15");
  });
});

describe("localDateInputValue / addLocalDays", () => {
  it("reads the local Y-M-D, not UTC's", () => {
    // A local afternoon that would already be the next UTC day somewhere —
    // the picker's own "Today" preset must still read this same local day.
    const date = new Date(2026, 5, 15, 23, 0, 0);
    expect(localDateInputValue(date)).toBe("2026-06-15");
  });

  it("adds local calendar days, not 24h increments — crossing a month boundary", () => {
    const date = new Date(2026, 5, 29);
    expect(addLocalDays(date, 7)).toBe("2026-07-06");
  });
});

describe("formatDueDate", () => {
  it("renders the same day regardless of the viewer's own zone (forced UTC)", () => {
    expect(formatDueDate("2026-06-15T00:00:00.000Z")).toBe("Jun 15");
  });
});

describe("formatDueTime", () => {
  it("renders the typed clock digits verbatim — floating, not converted", () => {
    expect(formatDueTime("14:30")).toBe("2:30 PM");
  });

  it("renders midnight and noon distinctly", () => {
    expect(formatDueTime("00:00")).toBe("12:00 AM");
    expect(formatDueTime("12:00")).toBe("12:00 PM");
  });
});

describe("isOverdue", () => {
  it("is false for today's own due day", () => {
    const now = new Date(2026, 5, 15, 9, 0, 0);
    expect(isOverdue(dateOnlyToWireDueDate("2026-06-15"), now)).toBe(false);
  });

  it("is true for a due day strictly before today", () => {
    const now = new Date(2026, 5, 15, 9, 0, 0);
    expect(isOverdue(dateOnlyToWireDueDate("2026-06-14"), now)).toBe(true);
  });

  it("is false for a due day after today", () => {
    const now = new Date(2026, 5, 15, 9, 0, 0);
    expect(isOverdue(dateOnlyToWireDueDate("2026-06-16"), now)).toBe(false);
  });
});

describe("dueBucket (#256's own Board swimlane)", () => {
  const now = new Date(2026, 5, 15, 9, 0, 0); // Monday, Jun 15 2026, local

  it("is 'noDate' for a Task with no due day at all", () => {
    expect(dueBucket(null, now)).toBe("noDate");
  });

  it("is 'overdue' for a due day strictly before today", () => {
    expect(dueBucket(dateOnlyToWireDueDate("2026-06-14"), now)).toBe("overdue");
  });

  it("is 'today' for today's own due day", () => {
    expect(dueBucket(dateOnlyToWireDueDate("2026-06-15"), now)).toBe("today");
  });

  it("is 'thisWeek' for the 6 local days right after today", () => {
    expect(dueBucket(dateOnlyToWireDueDate("2026-06-16"), now)).toBe("thisWeek");
    expect(dueBucket(dateOnlyToWireDueDate("2026-06-21"), now)).toBe("thisWeek");
  });

  it("is 'later' past that window", () => {
    expect(dueBucket(dateOnlyToWireDueDate("2026-06-22"), now)).toBe("later");
  });

  it("still buckets a completed Task by its own due day — the Done column, not this, is what separates complete from active", () => {
    expect(dueBucket(dateOnlyToWireDueDate("2026-06-14"), now)).toBe("overdue");
  });
});

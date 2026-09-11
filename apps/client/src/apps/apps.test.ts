import { describe, expect, it } from "vitest";
import { APPS, APPS_BY_KEY, appForPath } from "./apps.js";

/**
 * The App order and per-App Account Scope declaration (#187) — the App
 * Switcher and `RootLayout.tsx`'s own Account Scope visibility both read
 * `apps.ts` directly, so this covers the data contract they share rather
 * than duplicating it in each consumer's own test.
 */
describe("apps.ts (#187)", () => {
  it("names five Apps, Notes last and live since #193", () => {
    expect(APPS.map((app) => app.key)).toEqual(["mail", "contacts", "calendar", "tasks", "notes"]);
    expect(APPS_BY_KEY.notes.name).toBe("Notes");
    expect(APPS_BY_KEY.notes.available).toBe(true);
    expect(APPS_BY_KEY.notes.path).toBe("/notes");
    expect(appForPath("/notes")?.key).toBe("notes");
  });

  it("Calendar is live since #231; Contacts and Tasks stay reserved", () => {
    expect(APPS_BY_KEY.contacts.available).toBe(false);
    expect(APPS_BY_KEY.calendar.available).toBe(true);
    expect(APPS_BY_KEY.tasks.available).toBe(false);
  });

  it("Mail, Calendar and Contacts observe Account Scope; Tasks and Notes don't", () => {
    expect(APPS_BY_KEY.mail.observesAccountScope).toBe(true);
    expect(APPS_BY_KEY.calendar.observesAccountScope).toBe(true);
    expect(APPS_BY_KEY.contacts.observesAccountScope).toBe(true);
    expect(APPS_BY_KEY.tasks.observesAccountScope).toBe(false);
    expect(APPS_BY_KEY.notes.observesAccountScope).toBe(false);
  });
});

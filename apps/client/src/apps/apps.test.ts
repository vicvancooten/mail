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

  it("Contacts (#211), Calendar (#231) and Tasks (#252) are all live", () => {
    expect(APPS_BY_KEY.contacts.available).toBe(true);
    expect(APPS_BY_KEY.calendar.available).toBe(true);
    expect(APPS_BY_KEY.tasks.available).toBe(true);
  });

  it("Mail, Calendar and Contacts observe Account Scope; Tasks and Notes don't", () => {
    expect(APPS_BY_KEY.mail.observesAccountScope).toBe(true);
    expect(APPS_BY_KEY.calendar.observesAccountScope).toBe(true);
    expect(APPS_BY_KEY.contacts.observesAccountScope).toBe(true);
    expect(APPS_BY_KEY.tasks.observesAccountScope).toBe(false);
    expect(APPS_BY_KEY.notes.observesAccountScope).toBe(false);
  });

  /**
   * The Dock's own registry (#318, decision B): every App names exactly one
   * `primaryAction`; only Mail, Calendar and Tasks also name a `navControl`
   * — the Dock renders `[switcher][navControl?][primaryAction]`
   * (`router/Dock.tsx`), so Mail/Calendar/Tasks show three tiles and
   * Contacts/Notes show two.
   */
  it("every App names exactly one primaryAction", () => {
    expect(APPS_BY_KEY.mail.primaryAction.label).toBe("Compose");
    expect(APPS_BY_KEY.contacts.primaryAction.label).toBe("New contact");
    expect(APPS_BY_KEY.calendar.primaryAction.label).toBe("New event");
    expect(APPS_BY_KEY.tasks.primaryAction.label).toBe("New task");
    expect(APPS_BY_KEY.notes.primaryAction.label).toBe("New note");
  });

  it("only Mail, Calendar and Tasks name a navControl; Contacts and Notes name none", () => {
    expect(APPS_BY_KEY.mail.navControl?.label).toBe("Folders");
    expect(APPS_BY_KEY.calendar.navControl?.label).toBe("Calendars");
    expect(APPS_BY_KEY.tasks.navControl?.label).toBe("Lists");
    expect(APPS_BY_KEY.contacts.navControl).toBeUndefined();
    expect(APPS_BY_KEY.notes.navControl).toBeUndefined();
  });
});

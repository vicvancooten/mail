import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FolderRole, FolderRow } from "./folders.js";
import { resolveSyncPlan, resolveWatchFolder } from "./sync-plan.js";

/**
 * Pure unit tests, no database or IMAP client — `resolveSyncPlan` and
 * `resolveWatchFolder` are plain functions over already-persisted `FolderRow`
 * data (#122). GreenMail proving the generic path unaffected lives in
 * `sync-plan.greenmail.test.ts`; a live Gmail server's real folder names in
 * `sync-plan.live-gmail.test.ts`.
 */
function fakeFolder(role: FolderRole | null, overrides: Partial<FolderRow> = {}): FolderRow {
  return {
    id: overrides.id ?? randomUUID(),
    mailAccountId: overrides.mailAccountId ?? "account-1",
    path: overrides.path ?? role ?? "custom",
    name: overrides.name ?? role ?? "custom",
    delimiter: "/",
    role,
    subscribed: true,
    selectable: overrides.selectable ?? true,
    uidValidity: null,
    uidNext: null,
    highestModseq: null,
    lastSyncedAt: null,
    backfillCursorSeq: null,
    backfillComplete: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("resolveSyncPlan", () => {
  it("is every selectable folder on a generic account, unchanged", () => {
    const inbox = fakeFolder("inbox");
    const sent = fakeFolder("sent");
    const archive = fakeFolder("archive");
    const userFolder = fakeFolder(null, { name: "Projects" });
    const folders = [inbox, sent, archive, userFolder, fakeFolder("trash", { selectable: false })];
    const plan = resolveSyncPlan("generic", folders);
    expect(plan.map((folder) => folder.id).sort()).toEqual(
      [inbox, sent, archive, userFolder].map((folder) => folder.id).sort(),
    );
  });

  it("is the same on a null (undetected) server kind as on generic", () => {
    const folders = [fakeFolder("inbox"), fakeFolder(null, { name: "Projects" })];
    expect(resolveSyncPlan(null, folders)).toHaveLength(2);
  });

  it("is exactly All Mail, Spam, Trash and Drafts on a Gmail account", () => {
    const folders = [
      fakeFolder("all", { path: "[Gmail]/All Mail" }),
      fakeFolder("junk", { path: "[Gmail]/Spam" }),
      fakeFolder("trash", { path: "[Gmail]/Trash" }),
      fakeFolder("drafts", { path: "[Gmail]/Drafts" }),
      // Every other Gmail Label folder — the Inbox, Sent, and every user
      // label — is discovered and role-recorded (`folders.ts`) but never
      // synced.
      fakeFolder("inbox", { path: "INBOX" }),
      fakeFolder("sent", { path: "[Gmail]/Sent Mail" }),
      fakeFolder(null, { path: "Some Label", name: "Some Label" }),
    ];
    const plan = resolveSyncPlan("gmail", folders);
    expect(plan.map((folder) => folder.role).sort()).toEqual(["all", "drafts", "junk", "trash"]);
  });

  it("drops an unselectable Gmail Folder even if its role is in the plan", () => {
    const folders = [fakeFolder("all", { selectable: false })];
    expect(resolveSyncPlan("gmail", folders)).toHaveLength(0);
  });
});

describe("resolveWatchFolder", () => {
  it("picks INBOX on a generic account", () => {
    const inbox = fakeFolder("inbox");
    const plan = [inbox, fakeFolder("sent")];
    expect(resolveWatchFolder("generic", plan)?.id).toBe(inbox.id);
  });

  it("picks All Mail on a Gmail account, not INBOX", () => {
    const allMail = fakeFolder("all", { path: "[Gmail]/All Mail" });
    const plan = [allMail, fakeFolder("trash"), fakeFolder("junk"), fakeFolder("drafts")];
    expect(resolveWatchFolder("gmail", plan)?.id).toBe(allMail.id);
  });

  it("is null when the plan has no matching folder — the caller's fatal-error seam", () => {
    expect(resolveWatchFolder("gmail", [fakeFolder("trash")])).toBeNull();
    expect(resolveWatchFolder("generic", [fakeFolder("sent")])).toBeNull();
  });
});

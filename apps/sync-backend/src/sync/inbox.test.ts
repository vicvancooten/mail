import { describe, expect, it } from "vitest";
import { isInInbox, projectGmailThreadStatus } from "./inbox.js";

/**
 * Pure unit tests for the Inbox predicate and the Gmail Thread projection
 * built on it (#122, ADR-0020) — labels and folder role in, `inInbox`/
 * `folderRole` out, no database or IMAP client involved.
 */
describe("isInInbox", () => {
  it("is true for a generic account's INBOX Folder", () => {
    expect(isInInbox("inbox", null)).toBe(true);
  });

  it("is false for any other generic Folder, regardless of labels", () => {
    expect(isInInbox("archive", null)).toBe(false);
    expect(isInInbox(null, null)).toBe(false);
  });

  it("is true on Gmail's All Mail when the message carries the \\Inbox label", () => {
    expect(isInInbox("all", ["\\Inbox"])).toBe(true);
    expect(isInInbox("all", ["\\Important", "\\Inbox"])).toBe(true);
  });

  it("is false on Gmail's All Mail with no \\Inbox label", () => {
    expect(isInInbox("all", [])).toBe(false);
    expect(isInInbox("all", null)).toBe(false);
    expect(isInInbox("all", ["Some User Label"])).toBe(false);
  });
});

describe("projectGmailThreadStatus", () => {
  it("projects \\Inbox on All Mail to inbox", () => {
    expect(projectGmailThreadStatus("all", ["\\Inbox"])).toEqual({
      folderRole: "inbox",
      inInbox: true,
    });
  });

  it("projects All Mail with no label to archive", () => {
    expect(projectGmailThreadStatus("all", [])).toEqual({
      folderRole: "archive",
      inInbox: false,
    });
    expect(projectGmailThreadStatus("all", null)).toEqual({
      folderRole: "archive",
      inInbox: false,
    });
  });

  it("projects a row in the Trash Folder to trash regardless of labels", () => {
    expect(projectGmailThreadStatus("trash", ["\\Inbox"])).toEqual({
      folderRole: "trash",
      inInbox: false,
    });
    expect(projectGmailThreadStatus("trash", null)).toEqual({
      folderRole: "trash",
      inInbox: false,
    });
  });

  it("projects a row in the Spam Folder to junk regardless of labels", () => {
    expect(projectGmailThreadStatus("junk", ["\\Inbox"])).toEqual({
      folderRole: "junk",
      inInbox: false,
    });
  });
});

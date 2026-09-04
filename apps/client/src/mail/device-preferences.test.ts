import { beforeEach, describe, expect, it } from "vitest";
import {
  readAccountScope,
  readGroupCollapsed,
  resolveAccountScope,
  writeAccountScope,
  writeGroupCollapsed,
} from "./device-preferences.js";

/**
 * Account Scope's device-preference seam (#73): the read/write pair and the
 * resolution rule `useAccountScope` builds on. `MailSection.test.tsx`
 * exercises the same behavior end to end (through the control, the merged
 * Thread list, and the notification-narrowing path); this is the narrower,
 * storage-level check.
 */

const ACCOUNTS = [{ id: "acct-1" }, { id: "acct-2" }, { id: "acct-3" }];

beforeEach(() => {
  localStorage.clear();
});

describe("resolveAccountScope", () => {
  it("defaults to every account when nothing is stored", () => {
    expect(resolveAccountScope(null, ACCOUNTS)).toEqual(["acct-1", "acct-2", "acct-3"]);
  });

  it("keeps a stored, still-valid subset — ordered by the account list, not the stored order", () => {
    expect(resolveAccountScope(["acct-3", "acct-1"], ACCOUNTS)).toEqual(["acct-1", "acct-3"]);
  });

  it("falls back to every account once a stored subset names no account that still exists", () => {
    expect(resolveAccountScope(["deleted-account"], ACCOUNTS)).toEqual([
      "acct-1",
      "acct-2",
      "acct-3",
    ]);
  });

  it("drops only the stale ids from a stored subset that's partly still valid", () => {
    expect(resolveAccountScope(["acct-2", "deleted-account"], ACCOUNTS)).toEqual(["acct-2"]);
  });
});

describe("readAccountScope / writeAccountScope", () => {
  it("round-trips a written Scope — the persistence acceptance criteria ('survives reload')", () => {
    writeAccountScope(["acct-2", "acct-3"]);
    expect(readAccountScope()).toEqual(["acct-2", "acct-3"]);
  });

  it("reads null when nothing has ever been written", () => {
    expect(readAccountScope()).toBeNull();
  });

  it("cannot be written empty — the acceptance criteria's 'cannot be emptied', enforced at the write seam too", () => {
    writeAccountScope(["acct-1"]);
    writeAccountScope([]);
    expect(readAccountScope()).toEqual(["acct-1"]);
  });

  it("reads null back from corrupt storage rather than throwing", () => {
    localStorage.setItem("mail.devicePref.accountScope", "{not json");
    expect(readAccountScope()).toBeNull();
  });
});

/**
 * Collapsed group state's device-preference seam (#78): keyed by the
 * group's own label, per the acceptance criteria's "keyed by group label" —
 * `VirtualizedThreadList.test.tsx` exercises the same behavior end to end
 * through the header cluster.
 */
describe("readGroupCollapsed / writeGroupCollapsed", () => {
  it("defaults to expanded when nothing is stored", () => {
    expect(readGroupCollapsed("Today")).toBe(false);
  });

  it("round-trips a collapsed group — persists per device and survives reload", () => {
    writeGroupCollapsed("Today", true);
    expect(readGroupCollapsed("Today")).toBe(true);
  });

  it("keys state per label — collapsing one group leaves another untouched", () => {
    writeGroupCollapsed("Today", true);
    expect(readGroupCollapsed("Yesterday")).toBe(false);
  });

  it("un-collapsing clears the stored key rather than leaving a false behind", () => {
    writeGroupCollapsed("Today", true);
    writeGroupCollapsed("Today", false);
    expect(readGroupCollapsed("Today")).toBe(false);
    expect(localStorage.getItem("mail.devicePref.groupCollapsed.Today")).toBeNull();
  });
});

import type { Correspondent } from "@mail/shared";
import { describe, expect, it } from "vitest";
import { correspondentLabel, matchCorrespondents } from "./recipients.js";

function correspondent(overrides: Partial<Correspondent> = {}): Correspondent {
  return {
    id: "acct-1:ann@example.com",
    mailAccountId: "acct-1",
    address: "ann@example.com",
    name: "Ann Chen",
    sentCount: 5,
    receivedCount: 1,
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    score: 10,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("correspondentLabel", () => {
  it("renders 'Name <address>' when a name is known", () => {
    expect(correspondentLabel(correspondent())).toBe("Ann Chen <ann@example.com>");
  });

  it("falls back to the bare address with no name", () => {
    expect(correspondentLabel(correspondent({ name: null }))).toBe("ann@example.com");
  });
});

describe("matchCorrespondents", () => {
  const ann = correspondent({ id: "a", address: "ann@example.com", name: "Ann Chen", score: 20 });
  const bo = correspondent({ id: "b", address: "bo@example.com", name: "Bo", score: 15 });
  const annette = correspondent({
    id: "c",
    address: "annette@example.com",
    name: null,
    score: 5,
  });
  const all = [ann, bo, annette];

  it("returns nothing for an empty query — the first keystroke has to land before anything renders", () => {
    expect(matchCorrespondents(all, "")).toEqual([]);
    expect(matchCorrespondents(all, "   ")).toEqual([]);
  });

  it("matches by address or display name, case-insensitively", () => {
    expect(matchCorrespondents(all, "ANN").map((c) => c.id)).toEqual(["a", "c"]);
    expect(matchCorrespondents(all, "bo").map((c) => c.id)).toEqual(["b"]);
  });

  it("preserves the input's score ordering rather than re-sorting", () => {
    // `annette` scores lowest but matches "ann" too — it must still come
    // after `ann` because the input list is already score-descending.
    expect(matchCorrespondents(all, "ann").map((c) => c.id)).toEqual(["a", "c"]);
  });

  it("excludes addresses already chipped in the field", () => {
    const exclude = new Set(["ann@example.com"]);
    expect(matchCorrespondents(all, "ann", { exclude }).map((c) => c.id)).toEqual(["c"]);
  });

  it("excludes case-insensitively, matching normalizeCorrespondentAddress", () => {
    const exclude = new Set(["ann@example.com"]);
    expect(
      matchCorrespondents([correspondent({ id: "d", address: "Ann@Example.com" })], "ann", {
        exclude,
      }),
    ).toEqual([]);
  });

  it("caps results at the given limit", () => {
    expect(matchCorrespondents(all, "a", { limit: 1 })).toHaveLength(1);
  });
});

import { describe, expect, it } from "vitest";
import { makeContact, makeCorrespondent } from "../test-support/mail-fixtures.js";
import {
  excludeContactAddresses,
  mergeCorrespondentsAcrossAccounts,
  peopleYouveMailed,
} from "./people-youve-mailed.js";

describe("mergeCorrespondentsAcrossAccounts (#218)", () => {
  it("merges Correspondents across Mail Accounts by normalised address, ranked by score", () => {
    const rows = mergeCorrespondentsAcrossAccounts([
      makeCorrespondent("c1", "acct-1", { address: "ada@example.test", score: 5 }),
      makeCorrespondent("c2", "acct-2", { address: "grace@example.test", score: 9 }),
    ]);

    expect(rows.map((row) => row.address)).toEqual(["grace@example.test", "ada@example.test"]);
  });

  it("collapses the same address across two Mail Accounts into one row, keeping the higher score", () => {
    const rows = mergeCorrespondentsAcrossAccounts([
      makeCorrespondent("c1", "acct-1", {
        address: "Ada@Example.test",
        name: "Ada",
        score: 3,
      }),
      makeCorrespondent("c2", "acct-2", {
        address: "ada@example.test",
        name: "Ada Lovelace",
        score: 8,
      }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ address: "ada@example.test", name: "Ada Lovelace", score: 8 });
  });
});

describe("excludeContactAddresses (#218)", () => {
  it("drops a row whose normalised address is already on a Contact", () => {
    const rows = mergeCorrespondentsAcrossAccounts([
      makeCorrespondent("c1", "acct-1", { address: "ada@example.test", score: 5 }),
      makeCorrespondent("c2", "acct-1", { address: "grace@example.test", score: 3 }),
    ]);
    const contacts = [
      makeContact("contact-1", "book-1", {
        emails: [{ id: "e1", type: "home", value: "Ada@Example.test", primary: true }],
      }),
    ];

    expect(excludeContactAddresses(rows, contacts).map((row) => row.address)).toEqual([
      "grace@example.test",
    ]);
  });
});

describe("peopleYouveMailed (#218)", () => {
  it("merges then excludes in one pass", () => {
    const correspondents = [
      makeCorrespondent("c1", "acct-1", { address: "ada@example.test", score: 5 }),
      makeCorrespondent("c2", "acct-2", { address: "ada@example.test", score: 1 }),
      makeCorrespondent("c3", "acct-1", { address: "grace@example.test", score: 9 }),
    ];
    const contacts = [
      makeContact("contact-1", "book-1", {
        emails: [{ id: "e1", type: "home", value: "grace@example.test", primary: true }],
      }),
    ];

    expect(peopleYouveMailed(correspondents, contacts)).toEqual([
      { address: "ada@example.test", name: null, score: 5 },
    ]);
  });
});

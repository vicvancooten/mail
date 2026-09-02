import { describe, expect, it } from "vitest";
import {
  meetsSearchFloor,
  parseSearchQuery,
  setQueryOperator,
  stripStopwords,
  toggleTrashJunkOperator,
} from "./query-parser.js";

describe("parseSearchQuery", () => {
  it("parses free text alone", () => {
    expect(parseSearchQuery("invoice march")).toEqual({ text: "invoice march" });
  });

  it("parses every known operator", () => {
    expect(
      parseSearchQuery(
        "from:vic to:team@x.test has:attachment in:archive before:2024-06-01 after:2024-01-01 label:invoices report",
      ),
    ).toEqual({
      text: "report",
      from: "vic",
      to: "team@x.test",
      hasAttachment: true,
      folder: "archive",
      before: "2024-06-01",
      after: "2024-01-01",
      label: "invoices",
    });
  });

  it("takes a double-quoted label value as one token", () => {
    expect(parseSearchQuery('label:"to read" report')).toEqual({
      text: "report",
      label: "to read",
    });
  });

  it("implicit AND: order doesn't matter, every operator applies", () => {
    expect(parseSearchQuery("report from:vic in:archive")).toEqual({
      text: "report",
      from: "vic",
      folder: "archive",
    });
  });

  it("falls through unknown foo: prefixes to free text rather than dropping them", () => {
    expect(parseSearchQuery("foo:bar report")).toEqual({ text: "foo:bar report" });
  });

  it("falls through has: with an unrecognized value", () => {
    expect(parseSearchQuery("has:calendar")).toEqual({ text: "has:calendar" });
  });

  it("falls through an operator with nothing after the colon", () => {
    expect(parseSearchQuery("from: report")).toEqual({ text: "from: report" });
  });

  it("drops -in:trash instead of negating it into inclusion", () => {
    expect(parseSearchQuery("-in:trash report")).toEqual({ text: "report" });
  });

  it("keeps a literal leading dash in free text — negation is operators-only", () => {
    expect(parseSearchQuery("-standalone")).toEqual({ text: "-standalone" });
  });

  it("is case-insensitive on operator keys", () => {
    expect(parseSearchQuery("FROM:vic IN:Archive")).toEqual({
      from: "vic",
      folder: "Archive",
      text: "",
    });
  });

  it("last occurrence of a repeated operator wins", () => {
    expect(parseSearchQuery("from:vic from:ada")).toEqual({ text: "", from: "ada" });
  });
});

describe("setQueryOperator", () => {
  it("appends a fresh operator", () => {
    expect(setQueryOperator("report", "in", "archive")).toBe("report in:archive");
  });

  it("replaces an existing operator rather than duplicating it", () => {
    expect(setQueryOperator("report in:inbox", "in", "archive")).toBe("report in:archive");
  });

  it("removes the operator when value is null", () => {
    expect(setQueryOperator("report in:archive", "in", null)).toBe("report");
  });

  it("also strips a negated occurrence of the same key", () => {
    expect(setQueryOperator("report -in:junk", "in", "trash")).toBe("report in:trash");
  });

  it("quotes a value containing whitespace", () => {
    expect(setQueryOperator("report", "label", "to read")).toBe('report label:"to read"');
  });
});

describe("toggleTrashJunkOperator", () => {
  it("writes in:trash from a plain query", () => {
    expect(toggleTrashJunkOperator("report")).toBe("report in:trash");
  });

  it("removes in:trash on the second press", () => {
    expect(toggleTrashJunkOperator("report in:trash")).toBe("report");
  });

  it("removes in:junk too — one toggle covers both", () => {
    expect(toggleTrashJunkOperator("report in:junk")).toBe("report");
  });
});

describe("meetsSearchFloor", () => {
  it("is false under 3 free-text characters with no filters", () => {
    expect(meetsSearchFloor(parseSearchQuery("ab"))).toBe(false);
  });

  it("is true at 3 free-text characters", () => {
    expect(meetsSearchFloor(parseSearchQuery("abc"))).toBe(true);
  });

  it("is true for a structured filter alone, however short the free text", () => {
    expect(meetsSearchFloor(parseSearchQuery("from:vic"))).toBe(true);
  });
});

describe("stripStopwords", () => {
  it("drops English and Dutch stopwords", () => {
    expect(stripStopwords("the invoice for march")).toBe("invoice march");
  });

  it("runs a query of only stopwords as-is rather than emptying it", () => {
    expect(stripStopwords("the of")).toBe("the of");
  });
});

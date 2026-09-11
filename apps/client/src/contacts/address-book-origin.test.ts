import { describe, expect, it } from "vitest";
import { addressBookOriginLabel } from "./address-book-origin.js";

describe("addressBookOriginLabel (#211)", () => {
  it("names every declared capability table", () => {
    expect(addressBookOriginLabel("local")).toBe("Local");
    expect(addressBookOriginLabel("google")).toBe("Google");
    expect(addressBookOriginLabel("microsoft")).toBe("Microsoft");
    expect(addressBookOriginLabel("caldav_carddav")).toBe("CardDAV");
  });
});

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Avatar } from "./Avatar.js";

afterEach(() => {
  cleanup();
});

/**
 * #221's own acceptance lines: a matched Contact's photo replaces the
 * initials tile; an unmatched address (or a Contact with no photo, which
 * `photoUrl` reads identically to "unmatched") still gets initials.
 */
describe("Avatar", () => {
  it("renders initials with no photoUrl", () => {
    const { container } = render(<Avatar name="Ada Lovelace" />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".mail-avatar")?.textContent).toBe("AL");
  });

  it("renders the photo in place of initials once one is given", () => {
    const { container } = render(<Avatar name="Ada Lovelace" photoUrl="/contacts/c1/photo" />);
    const img = container.querySelector<HTMLImageElement>(".mail-avatar-image");
    expect(img).not.toBeNull();
    expect(img?.src).toContain("/contacts/c1/photo");
    expect(container.querySelector(".mail-avatar")?.textContent).toBe("");
  });

  it("treats an explicit null the same as no photoUrl at all", () => {
    const { container } = render(<Avatar name="Ada Lovelace" photoUrl={null} />);
    expect(container.querySelector("img")).toBeNull();
  });
});

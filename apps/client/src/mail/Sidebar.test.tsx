import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar.js";

/**
 * The folder rail (#74, #93). jsdom computes no layout, which is exactly why
 * the regression this pins got through: shadcn's `SidebarProvider` wrapper —
 * `flex min-h-svh w-full`, an app-shell box — silently took `.mail-frame`'s
 * entire width in a real browser, `.mail-body` computed to `0px`, and every
 * Mail view rendered off the right edge of the card while this rail beside
 * it looked perfect. The rail sits *beside* `.mail-body`, not around it, so
 * that wrapper must generate no box at all.
 *
 * `display: contents` is therefore asserted as the rendered inline style —
 * the one form of the fix a layout-blind test can hold onto.
 */

const props = {
  folder: "inbox" as const,
  onSelectFolder: vi.fn(),
  labels: [],
  labelFilter: null,
  onSelectLabel: vi.fn(),
  onCompose: vi.fn(),
  screenerCount: 0,
  draftsCount: 0,
  onOpenStream: vi.fn(),
};

afterEach(cleanup);

describe("Sidebar", () => {
  it("renders the rail's own entries", () => {
    render(<Sidebar {...props} />);
    expect(screen.getAllByRole("button", { name: /inbox/i }).length).toBeGreaterThan(0);
  });

  it("takes shadcn's provider wrapper out of the layout, so `.mail-body` keeps its width", () => {
    const { container } = render(<Sidebar {...props} />);
    const wrapper = container.querySelector<HTMLElement>('[data-slot="sidebar-wrapper"]');
    expect(wrapper).not.toBeNull();
    expect(wrapper?.style.display).toBe("contents");
    // The rail is inside it — which is why the wrapper's own box, not the
    // rail's, is what claimed the frame's whole width.
    expect(wrapper?.querySelector(".side-nav-desktop")).not.toBeNull();
  });

  it("keeps shadcn's own width variables on the wrapper, which `display: contents` still inherits", () => {
    const { container } = render(<Sidebar {...props} />);
    const wrapper = container.querySelector<HTMLElement>('[data-slot="sidebar-wrapper"]');
    expect(wrapper?.style.getPropertyValue("--sidebar-width")).not.toBe("");
  });
});

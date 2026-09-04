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
  gmailLabels: [],
  gmailLabelFilter: null,
  onSelectGmailLabel: vi.fn(),
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

  it('renders no "Gmail labels" heading when the account has none (#126, ADR-0020)', () => {
    render(<Sidebar {...props} />);
    expect(screen.queryAllByText("Gmail labels").length).toBe(0);
  });

  it('renders a "Gmail labels" section, and reports a click through onSelectGmailLabel', () => {
    const onSelectGmailLabel = vi.fn();
    render(
      <Sidebar
        {...props}
        gmailLabels={[
          {
            id: "acct-1:Family/Kids",
            mailAccountId: "acct-1",
            name: "Kids",
            path: "Family/Kids",
            updatedAt: "",
          },
        ]}
        onSelectGmailLabel={onSelectGmailLabel}
      />,
    );
    expect(screen.getAllByText("Gmail labels").length).toBeGreaterThan(0);
    const entries = screen.getAllByRole("button", { name: "Kids" });
    expect(entries.length).toBeGreaterThan(0);
    entries[0]?.click();
    expect(onSelectGmailLabel).toHaveBeenCalledWith("acct-1:Family/Kids");
  });

  /**
   * Post-merge #126 fix: a Wicket Label filter already clears the folder
   * row's own "active" highlight (`labelFilter !== null`) — a Gmail Label
   * filter has to do the same, or the ordinary Inbox row keeps reading as
   * current while a Gmail Label actually narrows what's on screen.
   */
  it("clears the folder row's active highlight while a Gmail Label filter is selected", () => {
    render(<Sidebar {...props} gmailLabelFilter="acct-1:Family/Kids" />);
    const inboxButtons = screen.getAllByRole("button", { name: /inbox/i });
    for (const button of inboxButtons) {
      expect(button.getAttribute("data-active")).toBe("false");
    }
  });

  it("still highlights the folder row when neither filter is selected", () => {
    render(<Sidebar {...props} />);
    const inboxButtons = screen.getAllByRole("button", { name: /inbox/i });
    expect(inboxButtons.some((button) => button.getAttribute("data-active") === "true")).toBe(
      true,
    );
  });
});

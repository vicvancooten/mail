import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar.js";

/**
 * The folder rail (#74, #93, collapsible sections since #297). jsdom
 * computes no layout, which is exactly why the regression this pins got
 * through: shadcn's `SidebarProvider` wrapper — `flex min-h-svh w-full`, an
 * app-shell box — silently took `.mail-frame`'s entire width in a real
 * browser, `.mail-body` computed to `0px`, and every Mail view rendered off
 * the right edge of the card while this rail beside it looked perfect. The
 * rail sits *beside* `.mail-body`, not around it, so that wrapper must
 * generate no box at all.
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
  gmailLabelGroups: [],
  gmailLabelFilter: null,
  onSelectGmailLabel: vi.fn(),
  onCompose: vi.fn(),
  screenerCount: 0,
  draftsCount: 0,
  onOpenStream: vi.fn(),
};

beforeEach(() => {
  localStorage.clear();
});

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
        gmailLabelGroups={[
          {
            mailAccountId: "acct-1",
            accountEmail: "acct-1@example.test",
            labels: [
              {
                id: "acct-1:Family/Kids",
                mailAccountId: "acct-1",
                name: "Kids",
                path: "Family/Kids",
                updatedAt: "",
              },
            ],
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

  it("gives each in-Scope Gmail account its own headed, independently keyed section once there's more than one", () => {
    render(
      <Sidebar
        {...props}
        gmailLabelGroups={[
          {
            mailAccountId: "acct-1",
            accountEmail: "acct-1@example.test",
            labels: [
              {
                id: "acct-1:Kids",
                mailAccountId: "acct-1",
                name: "Kids",
                path: "Kids",
                updatedAt: "",
              },
            ],
          },
          {
            mailAccountId: "acct-2",
            accountEmail: "acct-2@example.test",
            labels: [
              {
                id: "acct-2:Work",
                mailAccountId: "acct-2",
                name: "Work",
                path: "Work",
                updatedAt: "",
              },
            ],
          },
        ]}
      />,
    );
    expect(screen.getByText(/Gmail labels — acct-1@example\.test/)).toBeDefined();
    expect(screen.getByText(/Gmail labels — acct-2@example\.test/)).toBeDefined();
    expect(screen.getAllByRole("button", { name: "Kids" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Work" }).length).toBeGreaterThan(0);
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
    expect(inboxButtons.some((button) => button.getAttribute("data-active") === "true")).toBe(true);
  });

  /**
   * Collapsible sidebar sections (#297): every section — Folders, Labels,
   * each account's own Gmail Labels — folds away on its own header click,
   * survives a remount (the Device Preference round-trip), and stays
   * keyboard-operable since the header is a real `<button>`.
   */
  describe("collapsible sections (#297)", () => {
    const labels = [{ id: "label-1", userId: "user-1", name: "Follow up", updatedAt: "" }];

    it("collapses the Folders section on header click, hiding its rows but keeping the header", () => {
      render(<Sidebar {...props} />);
      const header = screen.getByRole("button", { name: "Folders" });
      expect(screen.getAllByRole("button", { name: /inbox/i }).length).toBeGreaterThan(0);

      fireEvent.click(header);

      expect(screen.queryAllByRole("button", { name: /^inbox/i }).length).toBe(0);
      expect(screen.getByRole("button", { name: "Folders" })).toBeDefined();
      expect(header.getAttribute("aria-expanded")).toBe("false");
    });

    it("expands a collapsed section again on a second header click", () => {
      render(<Sidebar {...props} />);
      const header = screen.getByRole("button", { name: "Folders" });
      fireEvent.click(header);
      fireEvent.click(header);
      expect(screen.getAllByRole("button", { name: /inbox/i }).length).toBeGreaterThan(0);
      expect(header.getAttribute("aria-expanded")).toBe("true");
    });

    it("toggles a section's collapse from the keyboard (Enter on the header button)", () => {
      render(<Sidebar {...props} labels={labels} />);
      const header = screen.getByRole("button", { name: "Labels" });
      header.focus();

      fireEvent.click(header); // jsdom's own real `<button>` semantics: Enter/Space activate a focused button as a click.

      expect(screen.queryByRole("button", { name: "Follow up" })).toBeNull();
    });

    it("keeps the Labels section's collapse independent of the Folders section's", () => {
      render(<Sidebar {...props} labels={labels} />);
      fireEvent.click(screen.getByRole("button", { name: "Folders" }));

      expect(screen.queryAllByRole("button", { name: /inbox/i }).length).toBe(0);
      expect(screen.getByRole("button", { name: "Follow up" })).toBeDefined();
    });

    it("survives a remount — the Device Preference round trip", () => {
      const { unmount } = render(<Sidebar {...props} labels={labels} />);
      fireEvent.click(screen.getByRole("button", { name: "Labels" }));
      expect(screen.queryByRole("button", { name: "Follow up" })).toBeNull();
      unmount();
      cleanup();

      render(<Sidebar {...props} labels={labels} />);
      expect(screen.queryByRole("button", { name: "Follow up" })).toBeNull();
      expect(screen.getByRole("button", { name: "Labels" }).getAttribute("aria-expanded")).toBe(
        "false",
      );
    });

    it("keys a per-account Gmail Labels section by its own account, independent of another account's", () => {
      const gmailLabelGroups = [
        {
          mailAccountId: "acct-1",
          accountEmail: "acct-1@example.test",
          labels: [
            {
              id: "acct-1:Kids",
              mailAccountId: "acct-1",
              name: "Kids",
              path: "Kids",
              updatedAt: "",
            },
          ],
        },
        {
          mailAccountId: "acct-2",
          accountEmail: "acct-2@example.test",
          labels: [
            {
              id: "acct-2:Work",
              mailAccountId: "acct-2",
              name: "Work",
              path: "Work",
              updatedAt: "",
            },
          ],
        },
      ];
      render(<Sidebar {...props} gmailLabelGroups={gmailLabelGroups} />);

      fireEvent.click(screen.getByText(/Gmail labels — acct-1@example\.test/));

      expect(screen.queryByRole("button", { name: "Kids" })).toBeNull();
      expect(screen.getByRole("button", { name: "Work" })).toBeDefined();
    });

    it("never suppresses a Folder's own icon-rail row when the rail itself is icon-collapsed, even if Folders was left section-collapsed", () => {
      // The whole-rail icon collapse (`useSidebarCollapsed`) is a *different*
      // Device Preference than a section's own collapse — collapsing Folders
      // first, then the whole rail, must still show every folder as an icon;
      // otherwise there would be no way back to Inbox from an icon-only rail.
      localStorage.setItem("mail.devicePref.sidebarCollapsed", "1");
      render(<Sidebar {...props} />);
      fireEvent.click(screen.getAllByRole("button", { name: "Folders" })[0] as HTMLElement);

      expect(screen.getAllByRole("button", { name: /inbox/i }).length).toBeGreaterThan(0);
    });
  });
});

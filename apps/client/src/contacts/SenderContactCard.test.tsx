import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localCache, openLocalCache } from "../store/local-cache.js";
import { applyThreadDelta } from "../store/server-writes.js";
import { setSessionUserId } from "../store/session.js";
import {
  delta,
  makeAddressBook,
  makeContact,
  makeThread,
  minutesAfterEpoch,
} from "../test-support/mail-fixtures.js";
import { stubMatchMedia } from "../test-support/match-media.js";
import { bannerStyleFor, contactBannerStyle } from "./contact-banner.js";
import { SenderContactCard } from "./SenderContactCard.js";

// `SenderContactCard` only ever reaches `Link` for "Open in Contacts"
// (`to="/contacts/$contactId"`) — a real `RouterProvider` is more machinery
// than this file needs, so it's swapped for a plain anchor, the same
// narrowing `router/MailRoute.test.tsx` already does for `useRouter`.
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({
      to,
      params,
      children,
    }: {
      to: string;
      params?: Record<string, string>;
      children: React.ReactNode;
    }) => <a href={`${to}/${params?.contactId ?? ""}`}>{children}</a>,
  };
});

let counter = 0;
const names: string[] = [];
const USER = "user-1";
const BOOK = makeAddressBook("book-1");

beforeEach(async () => {
  const name = `sender-contact-card-test-${counter++}`;
  names.push(name);
  await openLocalCache({ name, schemaVersion: 1 });
  setSessionUserId(USER);
  await localCache().addressBooks.put(BOOK);
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  localCache().close();
  setSessionUserId(null);
  for (const nm of names.splice(0)) await Dexie.delete(nm);
});

/**
 * Opens the card via tap — every content assertion below drives it this
 * way, since it's a synchronous `onClick` rather than Radix's own hover
 * delay (covered separately below). `stubMatchMedia` has to run *before*
 * `render`: `useHoverCapable`'s initial state and its one mount effect both
 * read `window.matchMedia` at mount time, so stubbing it after the
 * component is already up never reaches either.
 */
function openByTap() {
  fireEvent.click(screen.getByRole("button", { name: /Contact card for/ }));
}

describe("SenderContactCard (#293)", () => {
  it("a known sender shows their Contacts name, photo and 'Open in Contacts'", async () => {
    stubMatchMedia(() => false);
    await localCache().contacts.put(
      makeContact("contact-ann", BOOK.id, {
        name: { given: "Ann", family: "Example" },
        emails: [{ id: "e1", type: "work", value: "ann@example.test", primary: true }],
      }),
    );

    render(<SenderContactCard name="Ann" address="ann@example.test" threadId="t1" />);
    openByTap();

    expect(await screen.findByText("Ann Example")).not.toBeNull();
    expect(screen.getByText("ann@example.test")).not.toBeNull();
    const link = screen.getByRole("link", { name: "Open in Contacts" });
    expect(link.getAttribute("href")).toBe("/contacts/$contactId/contact-ann");
    expect(screen.queryByRole("button", { name: "Add to Contacts" })).toBeNull();
  });

  it("gives a matched Contact's own banner behind a larger photo — the same mechanism Contacts' own card uses", async () => {
    stubMatchMedia(() => false);
    await localCache().contacts.put(
      makeContact("contact-ann", BOOK.id, {
        name: { given: "Ann", family: "Example" },
        emails: [{ id: "e1", type: "work", value: "ann@example.test", primary: true }],
        banner: { kind: "swatch", swatch: "b" },
      }),
    );

    render(<SenderContactCard name="Ann" address="ann@example.test" threadId="t1" />);
    openByTap();

    await screen.findByText("Ann Example");
    const banner = document.querySelector(".sender-contact-card-banner") as HTMLElement;
    expect(banner).not.toBeNull();
    expect(banner.style.background).toBe(
      contactBannerStyle({ id: "contact-ann", banner: { kind: "swatch", swatch: "b" } }),
    );
    // The larger, overlapping photo — a second `Avatar` beyond the small
    // trigger tile, living inside the banner rather than the identity row
    // the old layout put it in.
    expect(banner.querySelector(".mail-avatar-wrap")).not.toBeNull();
  });

  it("falls back to the deterministic banner, keyed off the bare address, for a stranger with no Contact row", async () => {
    stubMatchMedia(() => false);
    render(<SenderContactCard name="Stranger" address="stranger@example.test" threadId="t1" />);
    openByTap();

    await screen.findByText("stranger@example.test");
    const banner = document.querySelector(".sender-contact-card-banner") as HTMLElement;
    // jsdom normalizes an `hsl(...)` background to its `rgb(...)` equivalent
    // once assigned — round-tripping the expected value through a scratch
    // element applies the same normalization to both sides rather than
    // comparing a raw `hsl(...)` string against jsdom's own rendering of it.
    const expected = document.createElement("div");
    expected.style.background = bannerStyleFor("stranger@example.test");
    expect(banner.style.background).toBe(expected.style.background);
  });

  it("an unknown sender shows the bare address and offers 'Add to Contacts'", async () => {
    stubMatchMedia(() => false);
    render(<SenderContactCard name="Stranger" address="stranger@example.test" threadId="t1" />);
    openByTap();

    expect(await screen.findByText("stranger@example.test")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Add to Contacts" })).not.toBeNull();
    expect(screen.queryByRole("link", { name: "Open in Contacts" })).toBeNull();
  });

  it("lists the last few Threads with that address, most recent first, excluding the open one", async () => {
    await applyThreadDelta(
      "acct-1",
      delta({
        created: [
          makeThread("t-open", "acct-1", {
            subject: "Currently open",
            participants: [{ name: "Ann", address: "ann@example.test" }],
          }),
          makeThread("t-older", "acct-1", {
            subject: "Older thread",
            participants: [{ name: "Ann", address: "ann@example.test" }],
            lastMessageAt: minutesAfterEpoch(1),
          }),
          makeThread("t-newer", "acct-1", {
            subject: "Newer thread",
            participants: [{ name: "Ann", address: "ann@example.test" }],
            lastMessageAt: minutesAfterEpoch(5),
          }),
        ],
      }),
      { replace: false },
    );

    stubMatchMedia(() => false);
    render(<SenderContactCard name="Ann" address="ann@example.test" threadId="t-open" />);
    openByTap();

    const subjects = (await screen.findAllByText(/thread$/i)).map((el) => el.textContent);
    expect(subjects).toEqual(["Newer thread", "Older thread"]);
    expect(screen.queryByText("Currently open")).toBeNull();
  });

  it("clicking 'Add to Contacts' opens the promotion dialog, prefilled with the address", async () => {
    stubMatchMedia(() => false);
    render(<SenderContactCard name="Stranger" address="stranger@example.test" threadId="t1" />);
    openByTap();

    fireEvent.click(screen.getByRole("button", { name: "Add to Contacts" }));

    await screen.findByRole("dialog");
    expect((screen.getByLabelText("Email value") as HTMLInputElement).value).toBe(
      "stranger@example.test",
    );
  });

  it("hover-capable: opens on pointer enter after Radix's own delay, closes on pointer leave", () => {
    vi.useFakeTimers();
    try {
      render(<SenderContactCard name="Ann" address="ann@example.test" threadId="t1" />);
      const trigger = screen.getByRole("button", { name: /Contact card for/ });

      fireEvent.pointerEnter(trigger);
      expect(screen.queryByText("ann@example.test")).toBeNull();
      act(() => {
        vi.advanceTimersByTime(700);
      });
      expect(screen.getByText("ann@example.test")).not.toBeNull();

      fireEvent.pointerLeave(trigger);
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(screen.queryByText("ann@example.test")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("touch: tapping the avatar toggles the card open and closed", () => {
    stubMatchMedia(() => false);
    render(<SenderContactCard name="Ann" address="ann@example.test" threadId="t1" />);
    const trigger = screen.getByRole("button", { name: /Contact card for/ });

    fireEvent.click(trigger);
    expect(screen.getByText("ann@example.test")).not.toBeNull();

    fireEvent.click(trigger);
    expect(screen.queryByText("ann@example.test")).toBeNull();
  });
});

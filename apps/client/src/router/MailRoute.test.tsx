import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocationChangeReason } from "../mail/MailSection.js";
import { MailRoute } from "./MailRoute.js";

/**
 * The push-vs-replace-vs-back decision itself (#140), isolated from a real
 * router: `app-shell-integration.test.tsx` drives the whole thing end to end,
 * but TanStack Router's own `commitLocation` no-ops a `navigate()` whose
 * target already matches the current URL — exactly what every
 * `"sync"`-tagged call (a Back/Forward gesture already moved the URL there)
 * produces — so a real Back-then-Forward round trip never surfaces the
 * duplicate-push bug as an extra `history.length` there even pre-fix. This
 * mocks `MailSection` down to its `onLocationChange` prop and asserts what
 * `navigate`/`router.history.back` are actually called with for the exact
 * sequence the bug report describes, which no router-level optimization can
 * paper over.
 */

const navigateMock = vi.fn();
const historyBackMock = vi.fn();
let searchThread: string | undefined;
let capturedOnLocationChange:
  | ((
      location: { labelFilter: string | null; folder: "inbox"; threadId: string | null },
      reason: LocationChangeReason,
    ) => void)
  | undefined;

vi.mock("./routes.js", () => ({
  mailRoute: {
    useSearch: () => ({ thread: searchThread, label: undefined, folder: "inbox" }),
    useNavigate: () => navigateMock,
  },
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return { ...actual, useRouter: () => ({ history: { back: historyBackMock } }) };
});

vi.mock("../mail/MailSection.js", () => ({
  MailSection: (props: { onLocationChange?: typeof capturedOnLocationChange }) => {
    capturedOnLocationChange = props.onLocationChange;
    return null;
  },
}));

function change(threadId: string | null, reason: LocationChangeReason) {
  capturedOnLocationChange?.({ labelFilter: null, folder: "inbox", threadId }, reason);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  capturedOnLocationChange = undefined;
  searchThread = undefined;
});

describe("MailRoute's push/replace/back decision (#140)", () => {
  it("opening a Thread from the list (a User-driven select with nothing previously selected) pushes", () => {
    render(<MailRoute />);

    change("t1", "select");

    expect(navigateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        search: expect.objectContaining({ thread: "t1" }),
        replace: false,
      }),
    );
  });

  it("moving between Threads (a select while one is already open) replaces", () => {
    render(<MailRoute />);
    change("t1", "select");
    navigateMock.mockClear();

    change("t2", "select");

    expect(navigateMock).toHaveBeenCalledWith(
      expect.objectContaining({ search: expect.objectContaining({ thread: "t2" }), replace: true }),
    );
  });

  it("closing the Reader pops the pushed entry via the router's own history.back, not a replace", () => {
    render(<MailRoute />);
    change("t1", "select"); // the push
    navigateMock.mockClear();

    change(null, "close");

    expect(historyBackMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("a Back gesture (sync) never navigates — the URL already reflects it", () => {
    render(<MailRoute />);
    change("t1", "select");
    navigateMock.mockClear();

    change(null, "sync"); // the phone/browser Back gesture closing the Reader

    expect(navigateMock).not.toHaveBeenCalled();
    expect(historyBackMock).not.toHaveBeenCalled();
  });

  it("#140's bug: a Forward re-entry (sync) after a Back-driven close never reads as a fresh opening", () => {
    render(<MailRoute />);
    change("t1", "select"); // push
    change(null, "sync"); // Back closes it — the marker resets, exactly like a fresh mount
    navigateMock.mockClear();

    change("t1", "sync"); // Forward re-enters the same Thread

    // Pre-#140, this reason wasn't tracked at all: the marker read as "no
    // Thread selected, now one is" and pushed a duplicate entry. A `"sync"`
    // must never push — the URL already says `thread=t1`.
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("closing after a Back-then-Forward re-entry still pops through history.back (the entry is still the top of the stack)", () => {
    render(<MailRoute />);
    change("t1", "select"); // push
    change(null, "sync"); // Back
    change("t1", "sync"); // Forward, back on top of the one real pushed entry
    navigateMock.mockClear();

    change(null, "close");

    // If the duplicate-push bug were still live, the entry pushed by
    // opening would no longer be the top of the stack by the time this ran
    // in a real browser, and closing would fall back to a `replace` instead
    // — leaving a ghost of the list for the next Back to walk through
    // (this ticket's other bug). One `history.back()` here is what proves
    // the marker still recognises this as the same, still-topmost entry.
    expect(historyBackMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("closing falls back to a plain replace when nothing was pushed this session (a reload straight onto a Thread)", () => {
    searchThread = "t1"; // seeded straight from the URL, no push happened
    render(<MailRoute />);

    change(null, "close");

    expect(historyBackMock).not.toHaveBeenCalled();
    expect(navigateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        search: expect.objectContaining({ thread: undefined }),
        replace: true,
      }),
    );
  });

  it("a folder/label switch that clears the selection (a select, not a close) replaces, never pops history", () => {
    render(<MailRoute />);
    change("t1", "select"); // push
    navigateMock.mockClear();

    change(null, "select"); // e.g. `selectFolder` clearing `selectedThreadId` alongside the folder

    expect(historyBackMock).not.toHaveBeenCalled();
    expect(navigateMock).toHaveBeenCalledWith(expect.objectContaining({ replace: true }));
  });
});

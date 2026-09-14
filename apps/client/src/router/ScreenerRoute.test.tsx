import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScreenerRoute } from "./ScreenerRoute.js";

/**
 * The go-back-vs-navigate decision itself, `StreamRoute.test.tsx`'s own
 * isolation: mocks `Screener` down to its `onClose` prop and `useRouter`
 * down to `history.canGoBack`/`history.back`, so the two branches are
 * provable without a real history stack to build up first. `app-shell-integration.test.tsx`
 * drives the warm and cold cases end to end over a real one — the cold-start
 * Gatekeeper digest deep-link test there is what exercises `?account=`
 * widening a narrowed Account Scope, this file's own `useMailAccounts`/
 * `useConnectedAccounts` mock stands in for the store entirely.
 */

const navigateMock = vi.fn();
const historyBackMock = vi.fn();
let canGoBack = false;
let capturedOnClose: (() => void) | undefined;

vi.mock("./routes.js", () => ({
  screenerRoute: {
    useNavigate: () => navigateMock,
    useSearch: () => ({ account: undefined }),
  },
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useRouter: () => ({
      history: { canGoBack: () => canGoBack, back: historyBackMock },
    }),
  };
});

vi.mock("../mail/screener/Screener.js", () => ({
  Screener: (props: { onClose: () => void }) => {
    capturedOnClose = props.onClose;
    return null;
  },
}));

vi.mock("../store/index.js", () => ({
  useMailAccounts: () => [{ id: "acct-1", connectedAccountId: "conn-1" }],
  useConnectedAccounts: () => undefined,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  capturedOnClose = undefined;
  canGoBack = false;
});

describe("ScreenerRoute's go-back-vs-navigate decision, StreamRoute's own shape (#141)", () => {
  it("leaving the Screener when it was entered from within the app (there's somewhere to go back to) goes back through history", () => {
    canGoBack = true;
    render(<ScreenerRoute />);

    capturedOnClose?.();

    expect(historyBackMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("leaving the Screener on a cold entry (nothing to go back to) navigates to Mail as a replace, not a push", () => {
    canGoBack = false;
    render(<ScreenerRoute />);

    capturedOnClose?.();

    expect(historyBackMock).not.toHaveBeenCalled();
    expect(navigateMock).toHaveBeenCalledWith({ to: "/mail", replace: true });
  });
});

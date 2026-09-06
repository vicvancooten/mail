import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StreamRoute } from "./StreamRoute.js";

/**
 * The go-back-vs-navigate decision itself (#141), isolated from a real
 * router the same way `MailRoute.test.tsx` isolates #140's: mocks
 * `StreamStack` down to its `onLeave` prop and `useRouter` down to
 * `history.canGoBack`/`history.back`, so the two branches are provable
 * without a real history stack to build up first.
 * `app-shell-integration.test.tsx` drives the warm and cold cases end to
 * end over a real one.
 */

const navigateMock = vi.fn();
const historyBackMock = vi.fn();
let canGoBack = false;
let capturedOnLeave: (() => void) | undefined;

vi.mock("./routes.js", () => ({
  streamRoute: {
    useNavigate: () => navigateMock,
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

vi.mock("../mail/stream/StreamStack.js", () => ({
  StreamStack: (props: { onLeave: () => void }) => {
    capturedOnLeave = props.onLeave;
    return null;
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  capturedOnLeave = undefined;
  canGoBack = false;
});

describe("StreamRoute's go-back-vs-navigate decision (#141)", () => {
  it("leaving Stream when it was entered from within the app (there's somewhere to go back to) goes back through history", () => {
    canGoBack = true;
    render(<StreamRoute />);

    capturedOnLeave?.();

    expect(historyBackMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("leaving Stream on a cold entry (nothing to go back to) navigates to Mail as a replace, not a push", () => {
    canGoBack = false;
    render(<StreamRoute />);

    capturedOnLeave?.();

    expect(historyBackMock).not.toHaveBeenCalled();
    expect(navigateMock).toHaveBeenCalledWith({ to: "/mail", replace: true });
  });
});

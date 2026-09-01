import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localCache, openLocalCache } from "../store/local-cache.js";
import { applyCompositionDelta } from "../store/server-writes.js";
import { delta, makeComposition } from "../test-support/mail-fixtures.js";
import { SendFailureBanner } from "./SendFailureBanner.js";

/**
 * The ticket's "permanent rejection lands a badged Draft with the server's
 * text verbatim" line, at the surface the User actually reads it on.
 */

const ACCOUNT = "acct-1";
let counter = 0;
const names: string[] = [];

beforeEach(async () => {
  const name = `send-failure-test-${counter++}`;
  names.push(name);
  await openLocalCache({ name, schemaVersion: 1 });
});

afterEach(async () => {
  cleanup();
  localCache().close();
  for (const name of names.splice(0)) await Dexie.delete(name);
});

async function seed(overrides = {}) {
  await applyCompositionDelta(
    ACCOUNT,
    delta({ created: [makeComposition("comp-1", ACCOUNT, overrides)] }),
    { replace: false },
  );
}

describe("SendFailureBanner", () => {
  it("shows the SMTP rejection verbatim, and opens the badged Draft", async () => {
    await seed({ subject: "Dinner plans", sendError: "550 5.7.1 relay denied" });
    const onOpen = vi.fn();
    render(<SendFailureBanner mailAccountId={ACCOUNT} onOpen={onOpen} />);

    const banner = await waitFor(() => screen.getByRole("alert"));
    expect(banner.textContent).toContain("Send failed");
    expect(banner.textContent).toContain("Dinner plans");
    // Verbatim: compose-spec would rather show `550 5.7.1 relay denied` than
    // anything friendlier, because only the former is actionable.
    expect(banner.textContent).toContain("550 5.7.1 relay denied");

    fireEvent.click(screen.getByRole("button", { name: "Open draft" }));
    expect(onOpen).toHaveBeenCalledWith("comp-1");
  });

  it("says nothing at all when no send has failed", async () => {
    await seed();
    const { container } = render(<SendFailureBanner mailAccountId={ACCOUNT} onOpen={() => {}} />);
    await waitFor(() => {
      expect(container.querySelector(".send-failure-banner")).toBeNull();
    });
  });

  it("clears once the send is re-armed — 'resolved' is a real event, not a dismissal", async () => {
    await seed({ sendError: "550 5.7.1 relay denied" });
    render(<SendFailureBanner mailAccountId={ACCOUNT} onOpen={() => {}} />);
    await waitFor(() => screen.getByRole("alert"));

    // Exactly what `acceptSend` does server-side when the User sends again.
    await applyCompositionDelta(
      ACCOUNT,
      delta({
        updated: [
          makeComposition("comp-1", ACCOUNT, {
            status: "pending",
            sendError: null,
            submitAfter: new Date(Date.now() + 10_000).toISOString(),
          }),
        ],
        newState: "state-2",
      }),
      { replace: false },
    );

    await waitFor(() => {
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });
});

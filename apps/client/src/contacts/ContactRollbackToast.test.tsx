import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { toast } from "sonner";
import { afterEach, describe, expect, it } from "vitest";
import { Toaster } from "../components/ui/sonner.js";
import { makeContactRollback } from "../test-support/mail-fixtures.js";
import { ContactRollbackToast } from "./ContactRollbackToast.js";
import { notifyContactRollback } from "./contact-rollback-toast.js";

/** `toast()` only ever renders through a mounted `<Toaster />` (#93) — `RollbackToast.test.tsx`'s own shape. */
function renderWithToaster(ui: ReactElement) {
  return render(
    <>
      {ui}
      <Toaster />
    </>,
  );
}

afterEach(() => {
  cleanup();
  // `RollbackToast.test.tsx`'s own reasoning: Sonner's toast store outlives
  // `cleanup()`'s unmount.
  toast.dismiss();
});

describe("ContactRollbackToast", () => {
  it("renders nothing until a rollback is notified", () => {
    renderWithToaster(<ContactRollbackToast />);
    expect(screen.queryByText(/Couldn't sync/)).toBeNull();
  });

  it("names the Contact and the reason once a rollback arrives, then auto-dismisses", async () => {
    renderWithToaster(<ContactRollbackToast autoDismissMs={30} />);

    act(() => {
      notifyContactRollback(
        makeContactRollback("r1", "c1", { contactName: "Ada Lovelace", reason: "google_conflict" }),
      );
    });

    await waitFor(() =>
      expect(
        screen.getByText(
          'Couldn\'t sync "Ada Lovelace" to Google — it changed there first. Reverted.',
        ),
      ).toBeTruthy(),
    );
    await waitFor(() =>
      expect(
        screen.queryByText(
          'Couldn\'t sync "Ada Lovelace" to Google — it changed there first. Reverted.',
        ),
      ).toBeNull(),
    );
  });

  it("describes google_not_found distinctly from google_conflict", async () => {
    renderWithToaster(<ContactRollbackToast autoDismissMs={10_000} />);

    act(() => {
      notifyContactRollback(
        makeContactRollback("r1", "c1", {
          contactName: "Grace Hopper",
          reason: "google_not_found",
        }),
      );
    });

    await waitFor(() =>
      expect(
        screen.getByText(
          'Couldn\'t sync "Grace Hopper" to Google — it was deleted there. Reverted.',
        ),
      ).toBeTruthy(),
    );
  });

  it("replaces the message on a second rollback before the first dismisses (one at a time, RollbackToast's own posture)", async () => {
    renderWithToaster(<ContactRollbackToast autoDismissMs={10_000} />);

    act(() => {
      notifyContactRollback(makeContactRollback("r1", "c1", { contactName: "First" }));
    });
    act(() => {
      notifyContactRollback(makeContactRollback("r2", "c2", { contactName: "Second" }));
    });

    await waitFor(() => expect(screen.getByText(/"Second"/)).toBeTruthy());
    expect(screen.queryByText(/"First"/)).toBeNull();
  });
});

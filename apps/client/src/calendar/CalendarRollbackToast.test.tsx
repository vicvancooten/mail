import type { Rollback } from "@mail/shared";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import Dexie from "dexie";
import type { ReactElement } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Toaster } from "../components/ui/sonner.js";
import { localCache, openLocalCache } from "../store/local-cache.js";
import { CalendarRollbackToast } from "./CalendarRollbackToast.js";

function renderWithToaster(ui: ReactElement) {
  return render(
    <>
      {ui}
      <Toaster />
    </>,
  );
}

function rollback(patch: Partial<Rollback> = {}): Rollback {
  return {
    id: "rb-1",
    userId: "u1",
    collection: "Series",
    entityId: "series-1",
    reason: "Google rejected this change: its copy has moved on.",
    occurredAt: new Date().toISOString(),
    ...patch,
  };
}

let counter = 0;
const names: string[] = [];

beforeEach(async () => {
  const name = `calendar-rollback-toast-test-${counter++}`;
  names.push(name);
  await openLocalCache({ name, schemaVersion: 1 });
  localStorage.removeItem("mail-calendar-rollback-seen-ids");
});

afterEach(async () => {
  cleanup();
  toast.dismiss();
  localCache().close();
  for (const name of names.splice(0)) await Dexie.delete(name);
  localStorage.removeItem("mail-calendar-rollback-seen-ids");
});

describe("CalendarRollbackToast", () => {
  it("renders nothing when there are no Rollback rows", () => {
    renderWithToaster(<CalendarRollbackToast />);
    expect(screen.queryByText(/Google/)).toBeNull();
  });

  it("shows the Rollback's own reason once a row syncs in", async () => {
    renderWithToaster(<CalendarRollbackToast autoDismissMs={10_000} />);

    await act(async () => {
      await localCache().rollbacks.put(rollback());
    });

    await waitFor(() =>
      expect(screen.getByText("Google rejected this change: its copy has moved on.")).toBeTruthy(),
    );
  });

  it("shows a row only once per device even if the component remounts", async () => {
    await localCache().rollbacks.put(rollback());
    const { unmount } = renderWithToaster(<CalendarRollbackToast autoDismissMs={10_000} />);
    await waitFor(() =>
      expect(screen.getByText("Google rejected this change: its copy has moved on.")).toBeTruthy(),
    );
    toast.dismiss();
    unmount();
    cleanup();

    renderWithToaster(<CalendarRollbackToast autoDismissMs={10_000} />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText("Google rejected this change: its copy has moved on.")).toBeNull();
  });

  it("falls back to a generic message when the row carries no reason", async () => {
    renderWithToaster(<CalendarRollbackToast autoDismissMs={10_000} />);

    await act(async () => {
      await localCache().rollbacks.put(rollback({ id: "rb-2", reason: null }));
    });

    await waitFor(() =>
      expect(screen.getByText("Google rejected a change to this event — reverted.")).toBeTruthy(),
    );
  });
});

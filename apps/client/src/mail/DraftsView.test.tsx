import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CachedComposition } from "../store/index.js";
import { localCache, openLocalCache } from "../store/local-cache.js";
import { makeComposition, makeMailAccount } from "../test-support/mail-fixtures.js";
import { ActionsProvider } from "./actions/ActionsProvider.js";
import { noopActionContext } from "./actions/types.js";
import { DraftsView } from "./DraftsView.js";

function makeDraft(overrides: Partial<CachedComposition> = {}): CachedComposition {
  const { messageId: _messageId, ...wire } = makeComposition("c1", "acct-1", {
    subject: "Half a thought",
  });
  return {
    ...wire,
    sendState: null,
    createdAt: wire.updatedAt,
    ...overrides,
  };
}

let counter = 0;
const names: string[] = [];

beforeEach(async () => {
  const name = `drafts-view-test-${counter++}`;
  names.push(name);
  await openLocalCache({ name, schemaVersion: 1 });
});

afterEach(async () => {
  cleanup();
  localCache().close();
  for (const name of names.splice(0)) await Dexie.delete(name);
});

describe("DraftsView (#74, #94, #101)", () => {
  it("right-clicking a Draft row offers the registry's Draft menu, which reopens it", async () => {
    const onOpen = vi.fn();
    render(
      <ActionsProvider value={noopActionContext()}>
        <DraftsView drafts={[makeDraft()]} onOpen={onOpen} />
      </ActionsProvider>,
    );

    fireEvent.contextMenu(screen.getByRole("option", { name: /Half a thought/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Open draft" }));

    expect(onOpen).toHaveBeenCalledWith("c1");
  });

  it("renders the rows untouched with no registry context above them", () => {
    render(<DraftsView drafts={[makeDraft()]} onOpen={() => {}} />);
    expect(screen.getByRole("option", { name: /Half a thought/ })).toBeDefined();
  });

  it("Delete discards the Draft — the row's status flips, expunge and Undo ride #101's own path", async () => {
    const draft = makeDraft();
    await localCache().compositions.put(draft);

    render(
      <ActionsProvider value={noopActionContext()}>
        <DraftsView drafts={[draft]} onOpen={() => {}} />
      </ActionsProvider>,
    );

    fireEvent.contextMenu(screen.getByRole("option", { name: /Half a thought/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete draft" }));

    await waitFor(async () => {
      const row = await localCache().compositions.get("c1");
      expect(row?.status).toBe("discarded");
    });
  });

  it("shows the account badge only once the passed accounts span more than one", () => {
    const account1 = makeMailAccount("acct-1");
    const account2 = makeMailAccount("acct-2");
    const draft = makeDraft();

    const { rerender } = render(
      <DraftsView drafts={[draft]} onOpen={() => {}} accounts={[account1]} />,
    );
    expect(screen.queryByText(account1.emailAddress)).toBeNull();

    rerender(<DraftsView drafts={[draft]} onOpen={() => {}} accounts={[account1, account2]} />);
    expect(screen.getByText(account1.emailAddress)).toBeDefined();
  });
});

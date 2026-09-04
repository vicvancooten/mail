import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CachedComposition } from "../store/index.js";
import { makeComposition } from "../test-support/mail-fixtures.js";
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

afterEach(() => {
  cleanup();
});

describe("DraftsView (#74, #94)", () => {
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
});

import type { Correspondent } from "@mail/shared";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localCache, openLocalCache } from "../store/local-cache.js";
import { RecipientField } from "./RecipientField.js";

/**
 * Recipient autocomplete (#49, compose-spec §Recipient autocomplete): the
 * synced Correspondent table answers the first keystroke locally, with no
 * network wait — `searchCorrespondents` is mocked here specifically so a
 * local-only assertion can prove that.
 */
vi.mock("../api/correspondents.js", () => ({
  searchCorrespondents: vi.fn(async () => []),
}));

const MAIL_ACCOUNT_ID = "acct-1";

function correspondent(overrides: Partial<Correspondent>): Correspondent {
  return {
    id: `${MAIL_ACCOUNT_ID}:${overrides.address}`,
    mailAccountId: MAIL_ACCOUNT_ID,
    address: "someone@example.com",
    name: null,
    sentCount: 1,
    receivedCount: 0,
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    score: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

let counter = 0;

beforeEach(async () => {
  await openLocalCache({ name: `recipient-field-test-${counter++}`, schemaVersion: 1 });
});

afterEach(async () => {
  cleanup();
  await localCache().delete();
});

describe("RecipientField", () => {
  it("suggests from the synced local Correspondents on the first keystroke, no network wait", async () => {
    await localCache().correspondents.bulkPut([
      correspondent({ address: "ann@example.com", name: "Ann Chen", score: 20 }),
      correspondent({ address: "bob@example.com", name: "Bob", score: 10 }),
    ]);

    const onChange = vi.fn();
    render(
      <RecipientField
        label="To"
        mailAccountId={MAIL_ACCOUNT_ID}
        recipients={[]}
        onChange={onChange}
      />,
    );

    const input = screen.getByLabelText("To recipients");
    fireEvent.change(input, { target: { value: "ann" } });

    expect(await screen.findByText("Ann Chen <ann@example.com>")).not.toBeNull();
    expect(screen.queryByText("Bob <bob@example.com>")).toBeNull();
  });

  it("selecting a suggestion adds it as a recipient and clears the draft", async () => {
    await localCache().correspondents.bulkPut([
      correspondent({ address: "ann@example.com", name: "Ann Chen", score: 20 }),
    ]);

    const onChange = vi.fn();
    render(
      <RecipientField
        label="To"
        mailAccountId={MAIL_ACCOUNT_ID}
        recipients={[]}
        onChange={onChange}
      />,
    );

    const input = screen.getByLabelText("To recipients");
    fireEvent.change(input, { target: { value: "ann" } });
    fireEvent.click(await screen.findByText("Ann Chen <ann@example.com>"));

    expect(onChange).toHaveBeenCalledWith([{ name: "Ann Chen", address: "ann@example.com" }]);
  });

  it("selecting a suggestion by real mouse click never leaves a bogus extra chip from the raced blur", async () => {
    // A real click moves focus off the input *before* the click fires
    // (mousedown → blur → mouseup → click), racing the input's own
    // `onBlur`-driven `commitDraft()` — which would otherwise chip whatever
    // partial text is still in the input (`parseRecipients` accepts
    // anything, no validity check) as a second, bogus recipient alongside
    // the real one `selectSuggestion` commits. `userEvent`, unlike
    // `fireEvent`, reproduces that real focus/blur sequence.
    await localCache().correspondents.bulkPut([
      correspondent({ address: "ann@example.com", name: "Ann Chen", score: 20 }),
    ]);

    function Controlled() {
      const [recipients, setRecipients] = useState<{ name: string | null; address: string }[]>([]);
      return (
        <RecipientField
          label="To"
          mailAccountId={MAIL_ACCOUNT_ID}
          recipients={recipients}
          onChange={setRecipients}
        />
      );
    }

    const user = userEvent.setup();
    const { container } = render(<Controlled />);

    const input = screen.getByLabelText("To recipients");
    await user.type(input, "ann");
    const suggestion = await screen.findByText("Ann Chen <ann@example.com>");
    await user.click(suggestion);

    await waitFor(() => {
      expect(container.querySelectorAll(".recipient-chip")).toHaveLength(1);
    });
    expect(container.querySelector(".recipient-chip")?.textContent).toContain("Ann Chen");
  });

  it("Enter with a suggestion highlighted selects it instead of committing the raw draft", async () => {
    await localCache().correspondents.bulkPut([
      correspondent({ address: "ann@example.com", name: "Ann Chen", score: 20 }),
    ]);

    const onChange = vi.fn();
    render(
      <RecipientField
        label="To"
        mailAccountId={MAIL_ACCOUNT_ID}
        recipients={[]}
        onChange={onChange}
      />,
    );

    const input = screen.getByLabelText("To recipients");
    fireEvent.change(input, { target: { value: "ann" } });
    await screen.findByText("Ann Chen <ann@example.com>");
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith([{ name: "Ann Chen", address: "ann@example.com" }]);
  });

  it("already-chipped addresses are excluded from suggestions", async () => {
    await localCache().correspondents.bulkPut([
      correspondent({ address: "ann@example.com", name: "Ann Chen", score: 20 }),
    ]);

    render(
      <RecipientField
        label="To"
        mailAccountId={MAIL_ACCOUNT_ID}
        recipients={[{ name: "Ann Chen", address: "ann@example.com" }]}
        onChange={vi.fn()}
      />,
    );

    const input = screen.getByLabelText("To recipients");
    fireEvent.change(input, { target: { value: "ann" } });

    await waitFor(() => {
      expect(screen.queryByText("Ann Chen <ann@example.com>")).toBeNull();
    });
  });

  it("plain typing with no match falls back to ordinary chip entry on Enter", async () => {
    const onChange = vi.fn();
    render(
      <RecipientField
        label="To"
        mailAccountId={MAIL_ACCOUNT_ID}
        recipients={[]}
        onChange={onChange}
      />,
    );

    const input = screen.getByLabelText("To recipients");
    fireEvent.change(input, { target: { value: "nobody@example.com" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith([{ name: null, address: "nobody@example.com" }]);
  });
});

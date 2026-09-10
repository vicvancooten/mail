import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeConnectedAccount } from "../test-support/mail-fixtures.js";
import { AccountScope } from "./AccountScope.js";

afterEach(() => {
  cleanup();
});

/**
 * The picker itself (#207): rendered from props alone, the same
 * `ConnectedAccountsTable.test.tsx` posture — no store, no Local Cache, just
 * `AccountScope`'s own rendering rules over a handful of `ConnectedAccount`
 * fixtures (`makeConnectedAccount(id)`'s own default `identity` strips a
 * trailing `-connected` off `id`, so `"acct-1-connected"` reads as
 * `acct-1@example.test`, `mail-fixtures.ts`'s own doc comment). `MailSection.test.tsx`'s
 * Account Scope suite and `search-integration.test.tsx`'s already cover the
 * store-wired path this builds on.
 */
describe("AccountScope", () => {
  it("renders nothing with a single Connected Account", () => {
    const accounts = [makeConnectedAccount("acct-1-connected")];
    const { container } = render(
      <AccountScope
        accounts={accounts}
        scope={["acct-1-connected"]}
        activeFacet="mail"
        onChange={vi.fn()}
      />,
    );
    expect(container.querySelector(".account-scope")).toBeNull();
  });

  it("lists every Connected Account by identity, with a Facet dot per Facet it carries", () => {
    const accounts = [
      makeConnectedAccount("acct-1-connected", { facets: [{ kind: "mail", status: "active" }] }),
      makeConnectedAccount("acct-2-connected", {
        facets: [
          { kind: "calendar", status: "active" },
          { kind: "contacts", status: "active" },
        ],
      }),
    ];
    render(
      <AccountScope
        accounts={accounts}
        scope={accounts.map((account) => account.id)}
        activeFacet="mail"
        onChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTitle("Account Scope"));

    const mailRow = screen.getByRole("checkbox", { name: "acct-1@example.test" });
    expect(mailRow.closest("label")?.querySelectorAll(".account-scope-facet-dot")).toHaveLength(1);

    const calendarContactsRow = screen.getByRole("checkbox", { name: "acct-2@example.test" });
    expect(
      calendarContactsRow.closest("label")?.querySelectorAll(".account-scope-facet-dot"),
    ).toHaveLength(2);
  });

  it("mutes (but keeps checkable) an account with no Facet feeding the current App", () => {
    const accounts = [
      makeConnectedAccount("acct-1-connected", { facets: [{ kind: "mail", status: "active" }] }),
      makeConnectedAccount("acct-2-connected", {
        facets: [{ kind: "calendar", status: "active" }],
      }),
    ];
    const onChange = vi.fn();
    render(
      <AccountScope
        accounts={accounts}
        scope={accounts.map((account) => account.id)}
        activeFacet="mail"
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTitle("Account Scope"));

    const mailRow = screen.getByRole("checkbox", { name: "acct-1@example.test" });
    const calendarOnlyRow = screen.getByRole("checkbox", { name: "acct-2@example.test" });

    expect(mailRow.closest("label")?.classList.contains("account-scope-muted")).toBe(false);
    expect(calendarOnlyRow.closest("label")?.classList.contains("account-scope-muted")).toBe(true);

    // Still checkable — muted only dims it, never disables it.
    fireEvent.click(calendarOnlyRow);
    expect(onChange).toHaveBeenCalledWith(["acct-1-connected"]);
  });

  it("cannot be narrowed to nothing", () => {
    const accounts = [
      makeConnectedAccount("acct-1-connected"),
      makeConnectedAccount("acct-2-connected"),
    ];
    const onChange = vi.fn();
    render(
      <AccountScope
        accounts={accounts}
        scope={["acct-1-connected"]}
        activeFacet="mail"
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTitle("Account Scope"));

    fireEvent.click(screen.getByRole("checkbox", { name: "acct-1@example.test" }));

    expect(onChange).not.toHaveBeenCalled();
  });
});

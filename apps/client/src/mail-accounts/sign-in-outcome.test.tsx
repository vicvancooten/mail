import { describe, expect, it } from "vitest";
import { clearSignInOutcome, readSignInOutcome } from "./sign-in-outcome.js";

/**
 * The return leg of a Provider sign-in (#116): the callback redirected the
 * browser to `?oauth=<outcome>`, and this is what the User actually sees
 * when they land. The toast itself now renders from
 * `settings/ConnectedAccountsPage.tsx` (#201, replacing `MailAccountsSection`)
 * — covered end to end by `app-shell-integration.test.tsx`'s own oauth-toast
 * case, since that page needs the real router context
 * (`rootRoute.useRouteContext()`) to render at all.
 */

function landOn(search: string) {
  window.history.replaceState({}, "", `/settings/connected-accounts${search}`);
}

describe("readSignInOutcome", () => {
  it("reads a known outcome and its message", () => {
    expect(readSignInOutcome("?oauth=signed_in")).toMatchObject({
      outcome: "signed_in",
      succeeded: true,
    });
    expect(readSignInOutcome("?oauth=duplicate_address")).toMatchObject({
      outcome: "duplicate_address",
      succeeded: false,
    });
  });

  it("reads tenant_refused (#117) as a failure that names the organisation as the refuser", () => {
    expect(readSignInOutcome("?oauth=tenant_refused")).toMatchObject({
      outcome: "tenant_refused",
      succeeded: false,
      message: expect.stringContaining("organisation"),
    });
  });

  it("ignores a query string with no outcome, or an outcome this build doesn't know", () => {
    expect(readSignInOutcome("")).toBeNull();
    expect(readSignInOutcome("?other=1")).toBeNull();
    expect(readSignInOutcome("?oauth=made-up")).toBeNull();
  });
});

describe("clearSignInOutcome", () => {
  it("drops the outcome without adding a history entry, leaving other parameters alone", () => {
    landOn("?oauth=signed_in&keep=me");
    const before = window.history.length;

    clearSignInOutcome();

    expect(window.location.search).toBe("?keep=me");
    expect(window.history.length).toBe(before);
  });

  it("is a no-op when there is nothing to clear", () => {
    landOn("?keep=me");
    clearSignInOutcome();
    expect(window.location.search).toBe("?keep=me");
  });
});

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiError } from "../api/auth.js";
import { makeConnectedAccount } from "../test-support/mail-fixtures.js";
import { AddCalDavFacetForm } from "./AddCalDavFacetForm.js";

const createCalDavAccount = vi.fn();
const addCalDavFacet = vi.fn();

vi.mock("../api/connected-accounts.js", () => ({
  createCalDavAccount: (...args: unknown[]) =>
    (createCalDavAccount as unknown as (...a: unknown[]) => unknown)(...args),
  addCalDavFacet: (...args: unknown[]) =>
    (addCalDavFacet as unknown as (...a: unknown[]) => unknown)(...args),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

it("asks for a server, username and app password when this User has no CalDAV/CardDAV account yet", async () => {
  const user = userEvent.setup();
  createCalDavAccount.mockResolvedValue({
    connectedAccountId: "new-account",
    facet: "calendar",
    discovered: { count: 2, names: ["Work", "Home"] },
    supportsScheduling: true,
  });
  const onAdded = vi.fn();
  render(<AddCalDavFacetForm facet="calendar" connectedAccounts={[]} onAdded={onAdded} />);

  await user.type(screen.getByLabelText("Server or email address"), "dav.example.com");
  await user.type(screen.getByLabelText("Username"), "alice");
  await user.type(screen.getByLabelText("App password"), "app-specific-secret");
  await user.click(screen.getByRole("button", { name: "Discover and add" }));

  expect(createCalDavAccount).toHaveBeenCalledWith({
    serverAddress: "dav.example.com",
    username: "alice",
    password: "app-specific-secret",
    facet: "calendar",
  });
  expect(await screen.findByText("Found 2 calendars: Work, Home.")).toBeDefined();

  await user.click(screen.getByRole("button", { name: "Done" }));
  expect(onAdded).toHaveBeenCalled();
});

it("offers attaching to an existing CalDAV/CardDAV account without asking for a password again", async () => {
  const user = userEvent.setup();
  const existing = makeConnectedAccount("acct-1", {
    provider: "caldav_carddav",
    identity: "alice",
    facets: [{ kind: "calendar", status: "active" }],
  });
  addCalDavFacet.mockResolvedValue({
    connectedAccountId: "acct-1",
    facet: "contacts",
    discovered: { count: 1, names: ["Contacts"] },
    supportsScheduling: false,
  });
  render(<AddCalDavFacetForm facet="contacts" connectedAccounts={[existing]} onAdded={() => {}} />);

  expect(screen.queryByLabelText("App password")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Use alice" }));

  expect(addCalDavFacet).toHaveBeenCalledWith("acct-1", { facet: "contacts" });
  expect(await screen.findByText("Found 1 address book: Contacts.")).toBeDefined();
});

it("doesn't offer attaching to a CalDAV/CardDAV account that already has this Facet", () => {
  const existing = makeConnectedAccount("acct-1", {
    provider: "caldav_carddav",
    identity: "alice",
    facets: [{ kind: "calendar", status: "active" }],
  });
  render(<AddCalDavFacetForm facet="calendar" connectedAccounts={[existing]} onAdded={() => {}} />);

  // Already has Calendar — the chooser has nothing to offer, so this opens
  // straight on the fresh-entry form instead.
  expect(screen.getByLabelText("Server or email address")).toBeDefined();
});

it("distinguishes the three real discovery failures", async () => {
  const user = userEvent.setup();
  createCalDavAccount.mockRejectedValue(new ApiError(422, "credentials_rejected"));
  render(<AddCalDavFacetForm facet="calendar" connectedAccounts={[]} onAdded={() => {}} />);

  await user.type(screen.getByLabelText("Server or email address"), "dav.example.com");
  await user.type(screen.getByLabelText("Username"), "alice");
  await user.type(screen.getByLabelText("App password"), "wrong");
  await user.click(screen.getByRole("button", { name: "Discover and add" }));

  expect(await screen.findByText(/app-specific password/)).toBeDefined();
});

it("writes nothing when the server has no home-set for this Facet", async () => {
  const user = userEvent.setup();
  createCalDavAccount.mockRejectedValue(new ApiError(422, "no_home_set"));
  render(<AddCalDavFacetForm facet="contacts" connectedAccounts={[]} onAdded={() => {}} />);

  await user.type(screen.getByLabelText("Server or email address"), "dav.example.com");
  await user.type(screen.getByLabelText("Username"), "alice");
  await user.type(screen.getByLabelText("App password"), "secret");
  await user.click(screen.getByRole("button", { name: "Discover and add" }));

  expect(await screen.findByText(/no address book/)).toBeDefined();
});

it("reports an unreachable host distinctly", async () => {
  const user = userEvent.setup();
  createCalDavAccount.mockRejectedValue(new ApiError(502, "unreachable"));
  render(<AddCalDavFacetForm facet="calendar" connectedAccounts={[]} onAdded={() => {}} />);

  await user.type(screen.getByLabelText("Server or email address"), "dav.example.com");
  await user.type(screen.getByLabelText("Username"), "alice");
  await user.type(screen.getByLabelText("App password"), "secret");
  await user.click(screen.getByRole("button", { name: "Discover and add" }));

  expect(await screen.findByText("Couldn't reach that server.")).toBeDefined();
});

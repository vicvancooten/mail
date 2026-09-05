import { afterEach, describe, expect, it, vi } from "vitest";
import { MICROSOFT_SCOPES, microsoftProviderAdapter } from "./microsoft-adapter.js";

/**
 * The real Microsoft `ProviderAdapter` (#117) — everything Microsoft-shaped,
 * and the only place in the repo that knows what its token endpoint answers
 * with. `routes/oauth-signin.test.ts` drives the flow through a fake, so
 * this file's whole job is the wire format: what goes into the authorization
 * URL, what comes out of a token response, and which failure means what.
 */

const AUTH_INPUT = {
  clientId: "client-id",
  redirectUri: "https://mail.example.test/auth/oauth/microsoft/callback",
  state: "state-value",
  codeChallenge: "challenge-value",
};

/** A minimally valid id_token: only the payload segment is ever read (see the adapter's own note on why its signature isn't checked). */
function idToken(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `header.${payload}.signature`;
}

function mockTokenEndpoint(status: number, body: unknown) {
  const fetchMock = vi.fn(
    async (_url: string, _init: RequestInit) => new Response(JSON.stringify(body), { status }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("authorizationUrl", () => {
  it("asks for the mail-only scopes on the common authority, with PKCE and the account chooser", () => {
    const url = new URL(microsoftProviderAdapter.authorizationUrl(AUTH_INPUT));

    expect(url.origin + url.pathname).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    );
    expect(url.searchParams.get("scope")).toBe(MICROSOFT_SCOPES.join(" "));
    // ADR-0021's mail-only rule: IMAP + SMTP + offline_access + identity.
    expect(MICROSOFT_SCOPES).toContain("https://outlook.office.com/IMAP.AccessAsUser.All");
    expect(MICROSOFT_SCOPES).toContain("https://outlook.office.com/SMTP.Send");
    expect(MICROSOFT_SCOPES).toContain("offline_access");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("state-value");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-value");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("prompt")).toBe("select_account");
    expect(url.searchParams.get("login_hint")).toBeNull();
  });

  it("carries a login_hint when one is given — the reauth case's pre-selected address", () => {
    const url = new URL(
      microsoftProviderAdapter.authorizationUrl({
        ...AUTH_INPUT,
        loginHint: "her@outlook.com",
      }),
    );
    expect(url.searchParams.get("login_hint")).toBe("her@outlook.com");
  });
});

describe("exchangeCode", () => {
  const input = {
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: AUTH_INPUT.redirectUri,
    code: "auth-code",
    codeVerifier: "verifier",
  };

  it("returns the Grant, taking the address from the id_token's email claim", async () => {
    const fetchMock = mockTokenEndpoint(200, {
      access_token: "at",
      refresh_token: "rt",
      expires_in: 3600,
      scope: "https://outlook.office.com/IMAP.AccessAsUser.All email",
      id_token: idToken({ email: "someone@outlook.com" }),
    });

    const grant = await microsoftProviderAdapter.exchangeCode(input);

    expect(grant).toMatchObject({
      accessToken: "at",
      refreshToken: "rt",
      scope: ["https://outlook.office.com/IMAP.AccessAsUser.All", "email"],
      emailAddress: "someone@outlook.com",
    });
    expect(Date.parse(grant.expiresAt)).toBeGreaterThan(Date.now());

    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("expected the token endpoint to have been called");
    const body = new URLSearchParams(call[1].body as string);
    expect(Object.fromEntries(body)).toMatchObject({
      grant_type: "authorization_code",
      code: "auth-code",
      code_verifier: "verifier",
      client_secret: "client-secret",
      redirect_uri: AUTH_INPUT.redirectUri,
    });
  });

  it("falls back to preferred_username when the id_token carries no email claim", async () => {
    mockTokenEndpoint(200, {
      access_token: "at",
      refresh_token: "rt",
      expires_in: 3600,
      id_token: idToken({ preferred_username: "someone@contoso.onmicrosoft.com" }),
    });

    const grant = await microsoftProviderAdapter.exchangeCode(input);
    expect(grant.emailAddress).toBe("someone@contoso.onmicrosoft.com");
  });

  it("throws when Microsoft answers without a refresh token — a Grant that would die in an hour", async () => {
    mockTokenEndpoint(200, {
      access_token: "at",
      expires_in: 3600,
      id_token: idToken({ email: "someone@outlook.com" }),
    });
    await expect(microsoftProviderAdapter.exchangeCode(input)).rejects.toThrow(/refresh_token/);
  });

  it("throws when the id_token carries neither an email nor a preferred_username claim", async () => {
    mockTokenEndpoint(200, {
      access_token: "at",
      refresh_token: "rt",
      expires_in: 3600,
      id_token: idToken({ sub: "12345" }),
    });
    await expect(microsoftProviderAdapter.exchangeCode(input)).rejects.toThrow(
      /email.*preferred_username/,
    );
  });

  it("throws carrying Microsoft's own error code when the exchange is rejected", async () => {
    mockTokenEndpoint(400, { error: "invalid_grant", error_description: "AADSTS70008" });
    await expect(microsoftProviderAdapter.exchangeCode(input)).rejects.toThrow(/invalid_grant/);
  });
});

describe("refresh", () => {
  const input = { clientId: "client-id", clientSecret: "client-secret", refreshToken: "rt" };

  it("rotates the refresh token when Microsoft issues a new one", async () => {
    mockTokenEndpoint(200, { access_token: "new-at", refresh_token: "new-rt", expires_in: 3599 });

    const result = await microsoftProviderAdapter.refresh(input);

    expect(result).toMatchObject({ ok: true, accessToken: "new-at", refreshToken: "new-rt" });
  });

  it("echoes the original refresh token back when Microsoft doesn't rotate it", async () => {
    mockTokenEndpoint(200, { access_token: "new-at", expires_in: 3599 });

    expect(await microsoftProviderAdapter.refresh(input)).toMatchObject({
      ok: true,
      refreshToken: "rt",
    });
  });

  it("reports invalid_grant as a withdrawn Grant — the second door into Needs Reauth (ADR-0021)", async () => {
    mockTokenEndpoint(400, { error: "invalid_grant", error_description: "Token revoked" });

    expect(await microsoftProviderAdapter.refresh(input)).toMatchObject({
      ok: false,
      reason: "withdrawn",
    });
  });

  it("reports anything else as transient, so the refresh loop retries rather than parking the account", async () => {
    mockTokenEndpoint(503, { error: "temporarily_unavailable" });
    expect(await microsoftProviderAdapter.refresh(input)).toMatchObject({
      ok: false,
      reason: "transient",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNRESET");
      }),
    );
    expect(await microsoftProviderAdapter.refresh(input)).toMatchObject({
      ok: false,
      reason: "transient",
      detail: "ECONNRESET",
    });
  });
});

describe("isTenantRefusal", () => {
  it.each(["unauthorized_client", "consent_required", "interaction_required"])(
    "treats %s as a tenant refusal (ADR-0021: admin consent required, or IMAP blocked tenant-wide)",
    (error) => {
      expect(microsoftProviderAdapter.isTenantRefusal?.({ error })).toBe(true);
    },
  );

  it.each(["access_denied", "invalid_grant", "server_error", "temporarily_unavailable"])(
    "does not treat %s as a tenant refusal",
    (error) => {
      expect(microsoftProviderAdapter.isTenantRefusal?.({ error })).toBe(false);
    },
  );
});

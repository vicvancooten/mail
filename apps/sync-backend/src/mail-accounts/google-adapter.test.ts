import { afterEach, describe, expect, it, vi } from "vitest";
import { GOOGLE_SCOPES, googleProviderAdapter } from "./google-adapter.js";

/**
 * The real Google `ProviderAdapter` (#116) — everything Google-shaped, and
 * the only place in the repo that knows what its token endpoint answers
 * with. `routes/oauth-signin.test.ts` drives the flow through a fake, so
 * this file's whole job is the wire format: what goes into the
 * authorization URL, what comes out of a token response, and which failure
 * means a Grant is withdrawn rather than the network being unhappy.
 */

const AUTH_INPUT = {
  clientId: "client-id",
  redirectUri: "https://mail.example.test/auth/oauth/google/callback",
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
  it("asks for the mail-only scopes and the account chooser, with PKCE and an offline grant", () => {
    const url = new URL(googleProviderAdapter.authorizationUrl(AUTH_INPUT));

    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("scope")).toBe(GOOGLE_SCOPES.join(" "));
    // ADR-0021's mail-only rule: the IMAP/SMTP scope and identity, nothing
    // about Contacts or Calendar.
    expect(GOOGLE_SCOPES).toContain("https://mail.google.com/");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("state-value");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-value");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    // `access_type=offline` plus a consent prompt is what makes Google
    // issue a refresh token even to a User who has authorized before.
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")?.split(" ")).toContain("select_account");
    expect(url.searchParams.get("prompt")?.split(" ")).toContain("consent");
    expect(url.searchParams.get("login_hint")).toBeNull();
  });

  it("carries a login_hint when one is given — the reauth case's pre-selected address", () => {
    const url = new URL(
      googleProviderAdapter.authorizationUrl({ ...AUTH_INPUT, loginHint: "her@gmail.com" }),
    );
    expect(url.searchParams.get("login_hint")).toBe("her@gmail.com");
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
      scope: "https://mail.google.com/ email",
      id_token: idToken({ email: "someone@gmail.com" }),
    });

    const grant = await googleProviderAdapter.exchangeCode(input);

    expect(grant).toMatchObject({
      accessToken: "at",
      refreshToken: "rt",
      scope: ["https://mail.google.com/", "email"],
      emailAddress: "someone@gmail.com",
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

  it("throws when Google answers without a refresh token — a Grant that would die in an hour", async () => {
    mockTokenEndpoint(200, {
      access_token: "at",
      expires_in: 3600,
      id_token: idToken({ email: "someone@gmail.com" }),
    });
    await expect(googleProviderAdapter.exchangeCode(input)).rejects.toThrow(/refresh_token/);
  });

  it("throws when the id_token carries no email claim — the address must come from the Provider", async () => {
    mockTokenEndpoint(200, {
      access_token: "at",
      refresh_token: "rt",
      expires_in: 3600,
      id_token: idToken({ sub: "12345" }),
    });
    await expect(googleProviderAdapter.exchangeCode(input)).rejects.toThrow(/email claim/);
  });

  it("throws carrying Google's own error code when the exchange is rejected", async () => {
    mockTokenEndpoint(400, { error: "invalid_grant", error_description: "Bad Request" });
    await expect(googleProviderAdapter.exchangeCode(input)).rejects.toThrow(/invalid_grant/);
  });
});

describe("refresh", () => {
  const input = { clientId: "client-id", clientSecret: "client-secret", refreshToken: "rt" };

  it("echoes the original refresh token back, since Google does not rotate it", async () => {
    mockTokenEndpoint(200, { access_token: "new-at", expires_in: 3599, scope: "email" });

    const result = await googleProviderAdapter.refresh(input);

    expect(result).toMatchObject({
      ok: true,
      accessToken: "new-at",
      refreshToken: "rt",
      scope: ["email"],
    });
  });

  it("reports invalid_grant as a withdrawn Grant — the second door into Needs Reauth (ADR-0021)", async () => {
    mockTokenEndpoint(400, { error: "invalid_grant", error_description: "Token revoked" });

    expect(await googleProviderAdapter.refresh(input)).toMatchObject({
      ok: false,
      reason: "withdrawn",
    });
  });

  it("reports anything else as transient, so the refresh loop retries rather than parking the account", async () => {
    mockTokenEndpoint(503, { error: "backendError" });
    expect(await googleProviderAdapter.refresh(input)).toMatchObject({
      ok: false,
      reason: "transient",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNRESET");
      }),
    );
    expect(await googleProviderAdapter.refresh(input)).toMatchObject({
      ok: false,
      reason: "transient",
      detail: "ECONNRESET",
    });
  });
});

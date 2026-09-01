import {
  type AuthStatusResponse,
  authStatusResponseSchema,
  type ClaimRequest,
  type LoginRequest,
  type LoginResponse,
  type LoginTotpRequest,
  loginResponseSchema,
  type SessionResponse,
  sessionResponseSchema,
} from "@mail/shared";

/** Carries the backend's error code (e.g. `invalid_credentials`) so forms can show it. */
export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export async function errorCode(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error ?? `http_${response.status}`;
  } catch {
    return `http_${response.status}`;
  }
}

export async function postJson<T>(
  url: string,
  body: unknown,
  parse: (data: unknown) => T,
): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new ApiError(response.status, await errorCode(response));
  }
  return parse(await response.json());
}

/** Shared by `api/totp.ts` and `api/passkeys.ts` for their own GET/DELETE calls. */
export async function getJson<T>(url: string, parse: (data: unknown) => T): Promise<T> {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) {
    throw new ApiError(response.status, await errorCode(response));
  }
  return parse(await response.json());
}

/** Same shape as `postJson`, for the one PATCH endpoint (`api/send-settings.ts`). */
export async function patchJson<T>(
  url: string,
  body: unknown,
  parse: (data: unknown) => T,
): Promise<T> {
  const response = await fetch(url, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new ApiError(response.status, await errorCode(response));
  }
  return parse(await response.json());
}

export async function deleteRequest(url: string): Promise<void> {
  const response = await fetch(url, { method: "DELETE", credentials: "include" });
  if (!response.ok) {
    throw new ApiError(response.status, await errorCode(response));
  }
}

/** Like `postJson`, but for endpoints that reply with no body (204/201 `send()`) to parse. */
export async function postNoContent(url: string, body: unknown): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new ApiError(response.status, await errorCode(response));
  }
}

/** `deleteRequest` with a JSON body (`api/push.ts`'s unsubscribe, which names the endpoint to remove). */
export async function deleteNoContent(url: string, body: unknown): Promise<void> {
  const response = await fetch(url, {
    method: "DELETE",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new ApiError(response.status, await errorCode(response));
  }
}

export async function fetchAuthStatus(): Promise<AuthStatusResponse> {
  const response = await fetch("/auth/status", { credentials: "include" });
  if (!response.ok) {
    throw new ApiError(response.status, await errorCode(response));
  }
  return authStatusResponseSchema.parse(await response.json());
}

/** `null` means "not logged in" — expected, not thrown. */
export async function fetchSession(): Promise<SessionResponse | null> {
  const response = await fetch("/auth/session", { credentials: "include" });
  if (response.status === 401) {
    return null;
  }
  if (!response.ok) {
    throw new ApiError(response.status, await errorCode(response));
  }
  return sessionResponseSchema.parse(await response.json());
}

export function claim(input: ClaimRequest): Promise<SessionResponse> {
  return postJson("/auth/claim", input, (data) => sessionResponseSchema.parse(data));
}

/**
 * `LoginResponse` is a union (#32): a plain `{ user }` when no second factor
 * is enrolled — password login untouched — or `{ totpRequired, challengeToken }`
 * when it is, for `completeTotpLogin` to redeem.
 */
export function login(input: LoginRequest): Promise<LoginResponse> {
  return postJson("/auth/login", input, (data) => loginResponseSchema.parse(data));
}

export function completeTotpLogin(input: LoginTotpRequest): Promise<SessionResponse> {
  return postJson("/auth/login/totp", input, (data) => sessionResponseSchema.parse(data));
}

export async function logout(): Promise<void> {
  const response = await fetch("/auth/logout", { method: "POST", credentials: "include" });
  if (!response.ok && response.status !== 401) {
    throw new ApiError(response.status, await errorCode(response));
  }
}

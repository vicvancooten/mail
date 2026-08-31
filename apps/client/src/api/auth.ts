import {
  type AuthStatusResponse,
  authStatusResponseSchema,
  type ClaimRequest,
  type LoginRequest,
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

async function errorCode(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error ?? `http_${response.status}`;
  } catch {
    return `http_${response.status}`;
  }
}

async function postJson<T>(url: string, body: unknown, parse: (data: unknown) => T): Promise<T> {
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

export function login(input: LoginRequest): Promise<SessionResponse> {
  return postJson("/auth/login", input, (data) => sessionResponseSchema.parse(data));
}

export async function logout(): Promise<void> {
  const response = await fetch("/auth/logout", { method: "POST", credentials: "include" });
  if (!response.ok && response.status !== 401) {
    throw new ApiError(response.status, await errorCode(response));
  }
}

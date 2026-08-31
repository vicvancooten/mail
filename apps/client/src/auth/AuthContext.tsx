import type { ClaimRequest, LoginRequest, User } from "@mail/shared";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import * as authApi from "../api/auth.js";

export type AuthState =
  | { kind: "loading" }
  | { kind: "unclaimed" }
  | { kind: "login-required" }
  | { kind: "authenticated"; user: User };

interface AuthContextValue {
  state: AuthState;
  claim: (input: ClaimRequest) => Promise<void>;
  login: (input: LoginRequest) => Promise<void>;
  logout: () => Promise<void>;
  /**
   * The client half of the session seam: any future feature's fetch calls
   * this on a 401 to fall back to the login prompt. It only swaps this one
   * piece of state — poc-spec.md is explicit that session expiry never
   * wipes the rest of what the Client is showing.
   */
  handleUnauthorized: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      const status = await authApi.fetchAuthStatus();
      if (cancelled) return;
      if (!status.claimed) {
        setState({ kind: "unclaimed" });
        return;
      }

      const session = await authApi.fetchSession();
      if (cancelled) return;
      setState(
        session ? { kind: "authenticated", user: session.user } : { kind: "login-required" },
      );
    }

    bootstrap().catch(() => {
      if (!cancelled) {
        setState({ kind: "login-required" });
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const claim = useCallback(async (input: ClaimRequest) => {
    const { user } = await authApi.claim(input);
    setState({ kind: "authenticated", user });
  }, []);

  const login = useCallback(async (input: LoginRequest) => {
    const { user } = await authApi.login(input);
    setState({ kind: "authenticated", user });
  }, []);

  const logout = useCallback(async () => {
    await authApi.logout();
    setState({ kind: "login-required" });
  }, []);

  const handleUnauthorized = useCallback(() => {
    setState({ kind: "login-required" });
  }, []);

  return (
    <AuthContext.Provider value={{ state, claim, login, logout, handleUnauthorized }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}

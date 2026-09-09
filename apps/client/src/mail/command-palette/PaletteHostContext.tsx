import type { MailAccount } from "@mail/shared";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { type SearchState, useSearchState } from "../search/useSearchState.js";

/**
 * The Command Palette's shared state (#147): lifted to Hub level
 * (`router/RootLayout.tsx`) so the Palette is mounted once, above every App
 * and screen, rather than owned by `MailSection`. `useSearchState` itself
 * needed no change to move here — it already read nothing route- or
 * Mail-surface-specific (`useSearchOverlay`'s own doc comment: "plain
 * component state"), only `accountScope`/`mailAccounts`, which the Hub
 * already computes for `AccountScope` (#96).
 *
 * `MailSection` and `stream/StreamStack` both consume this instead of
 * calling `useSearchState` themselves, so there is exactly one search
 * session regardless of which routed surface is current — the same "one
 * shared hook so actions mean the same thing" reasoning the rest of this
 * codebase already follows.
 */
export interface PaletteHostControls {
  search: SearchState;
  paletteOpen: boolean;
  openPalette: () => void;
  closePalette: () => void;
}

const PaletteHostReactContext = createContext<PaletteHostControls | null>(null);

export function PaletteHostProvider({
  accountScope,
  mailAccounts,
  children,
}: {
  accountScope: readonly string[];
  mailAccounts: readonly MailAccount[];
  children: ReactNode;
}) {
  const search = useSearchState(accountScope, mailAccounts);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const value = useMemo<PaletteHostControls>(
    () => ({ search, paletteOpen, openPalette, closePalette }),
    [search, paletteOpen, openPalette, closePalette],
  );
  return (
    <PaletteHostReactContext.Provider value={value}>{children}</PaletteHostReactContext.Provider>
  );
}

/** Throws outside `PaletteHostProvider` — every routed surface that reaches for this is mounted under `RootLayout`, which always provides one. */
export function usePaletteHost(): PaletteHostControls {
  const ctx = useContext(PaletteHostReactContext);
  if (!ctx) throw new Error("usePaletteHost must be used within PaletteHostProvider");
  return ctx;
}

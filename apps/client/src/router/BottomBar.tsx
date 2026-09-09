import { PanelLeft, Plus } from "lucide-react";
import { useState } from "react";
import { PhoneSwitcher } from "../apps/AppSwitcher.js";
import { appForPath, appIconFor } from "../apps/apps.js";
import type { ActionContext } from "../mail/actions/types.js";

/**
 * The phone bottom bar (#155) — rescinds `DESIGN.md`'s earlier "no bottom
 * tab bar" for phone, deliberately: Folders, the App Switcher and Compose,
 * the three candidates the redesign brief named, all three kept. Global
 * chrome, mounted once by `RootLayout.tsx` right beside the header (both
 * retract together on scroll, `RootLayout.tsx`'s own `useChromeRetract`) —
 * `shell.css` hides this above 700px, keeping it phone-only the same "both
 * render, CSS decides" way `Sidebar.tsx`'s `DesktopRail`/`MobileSheet` pair
 * already does, rather than a JS width check that could disagree with the
 * CSS.
 *
 * Folders and Compose read `ctx` — whichever Mail-family surface is mounted
 * (`MailSection`, `stream/StreamStack`), or the Hub's own fallback — the
 * same `ActionContext` the Command Palette already reads from `RootLayout`,
 * so both work from Settings or a placeholder App too: the Hub's fallback
 * navigates to Mail first there rather than doing nothing (`onOpenFolders`,
 * `onCompose`), the same shape `onOpenStream` already uses for the Palette.
 * The App Switcher needs no `ctx` at all — it's `PhoneSwitcher` itself
 * (`apps/AppSwitcher.tsx`), reused directly rather than re-implemented, in
 * its `variant="bottom-bar"` skin.
 */
export function BottomBar({ pathname, ctx }: { pathname: string; ctx: ActionContext }) {
  const current = appForPath(pathname);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const CurrentIcon = appIconFor(current?.key ?? "mail");

  return (
    <nav className="bottom-bar" aria-label="Folders, switch app, and compose">
      <button type="button" className="bottom-bar-item" onClick={ctx.onOpenFolders}>
        <PanelLeft size={20} />
        <span>Folders</span>
      </button>
      <PhoneSwitcher
        current={current}
        CurrentIcon={CurrentIcon}
        open={switcherOpen}
        setOpen={setSwitcherOpen}
        variant="bottom-bar"
      />
      <button type="button" className="bottom-bar-item bottom-bar-compose" onClick={ctx.onCompose}>
        <Plus size={20} />
        <span>Compose</span>
      </button>
    </nav>
  );
}

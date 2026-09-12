import { useState } from "react";
import { PhoneSwitcher } from "../apps/AppSwitcher.js";
import { APPS_BY_KEY, type AppDockControl, appForPath, appIconFor } from "../apps/apps.js";
import type { ActionContext } from "../mail/actions/types.js";

/**
 * A Dock control's own `key` (`apps.ts#AppDockControl`) mapped to the
 * `ActionContext` callback it actually runs — behavior the Apps registry
 * itself stays free of (`apps.ts`'s own doc comment on `AppDockControl`),
 * the same split `apps/apps.ts#APP_ICONS` already keeps between "what an
 * App names" and "what actually runs it". Adding a new control an App wants
 * to declare is one entry here plus one in that App's own `dockControls`,
 * never a change to the Dock itself.
 */
const DOCK_ACTIONS: Record<string, (ctx: ActionContext) => void> = {
  folders: (ctx) => ctx.onOpenFolders(),
  compose: (ctx) => ctx.onCompose(),
};

/** `["Folders", "switch app", "Compose"]` → `"Folders, switch app, and Compose"` — the Dock's own accessible name, built from whichever controls the current App actually declares rather than a string hardcoded to Mail's own two. */
function joinNaturally(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join("");
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

/**
 * The phone Dock (#298, replacing #155's own bottom bar): a floating pill
 * at the foot of the screen rather than a bar framing it — `shell.css`'s
 * `.dock` — holding the App Switcher tile (`PhoneSwitcher`'s own
 * `variant="dock"` skin) plus whichever of the current App's own
 * `dockControls` (`apps/apps.ts#AppDef.dockControls`) it declares, at most
 * two either side of the switcher tile. An App with fewer than two — or
 * none, `apps.ts`'s own placeholder Apps today — simply renders fewer
 * tiles; there is no empty slot standing in for a control nobody declared.
 *
 * Global chrome, mounted once by `RootLayout.tsx` right beside the header
 * (both retract together on scroll, `RootLayout.tsx`'s own
 * `useChromeRetract`) — `shell.css` hides this above the app's one 768px
 * phone breakpoint (#273), keeping it phone-only the same "both render, CSS
 * decides" way `Sidebar.tsx`'s own `DesktopRail`/`MobileSheet` pair already
 * does, rather than a JS width check that could disagree with the CSS.
 *
 * A declared control's `run` is read from `ctx` — whichever Mail-family
 * surface is mounted (`MailSection`, `stream/StreamStack`), or the Hub's
 * own fallback — the same `ActionContext` the Command Palette already reads
 * from `RootLayout`, so Folders and Compose both work from Settings or a
 * placeholder App too: the Hub's fallback navigates to Mail first there
 * rather than doing nothing (`onOpenFolders`, `onCompose`), the same shape
 * `onOpenStream` already uses for the Palette. The App Switcher needs no
 * `ctx` at all — it's `PhoneSwitcher` itself (`apps/AppSwitcher.tsx`),
 * reused directly rather than re-implemented.
 */
export function Dock({ pathname, ctx }: { pathname: string; ctx: ActionContext }) {
  const current = appForPath(pathname);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const CurrentIcon = appIconFor(current?.key ?? "mail");
  // A pathname matching no App (Settings, the standalone Reader's own
  // fallback before it early-returns in `RootLayout.tsx`) falls back to
  // Mail's own two — the same "show it anyway" default `appIconFor` and
  // `accountScopeFacetForApp` (`apps.ts`) already take for a pathname with
  // no matching App, and what keeps Folders/Compose reachable from Settings
  // (`fallbackCtx`'s own "navigate to Mail first" shape, `RootLayout.tsx`).
  const controls = current?.dockControls ?? APPS_BY_KEY.mail.dockControls;
  const [before, after] = controls;

  const navLabel = joinNaturally(
    [before?.label, "switch app", after?.label].filter((label): label is string => Boolean(label)),
  );

  return (
    <nav className="dock" aria-label={navLabel}>
      {before && <DockControlButton control={before} ctx={ctx} />}
      <PhoneSwitcher
        current={current}
        CurrentIcon={CurrentIcon}
        open={switcherOpen}
        setOpen={setSwitcherOpen}
        variant="dock"
      />
      {after && <DockControlButton control={after} ctx={ctx} />}
    </nav>
  );
}

function DockControlButton({ control, ctx }: { control: AppDockControl; ctx: ActionContext }) {
  const Icon = control.icon;
  const run = DOCK_ACTIONS[control.key];
  // Compose keeps the one bit of personality the old bottom bar gave it — a
  // quarter turn of the plus on press — everything else about it is the
  // same ghost `dock-item` voice every other tile shares.
  const className = control.key === "compose" ? "dock-item dock-compose" : "dock-item";
  return (
    <button type="button" className={className} onClick={() => run?.(ctx)}>
      <Icon size={20} />
      <span>{control.label}</span>
    </button>
  );
}

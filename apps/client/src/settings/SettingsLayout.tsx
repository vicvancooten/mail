import { Link, Outlet } from "@tanstack/react-router";
import { AtSign, Bell, Lock, Monitor, ShieldCheck, SlidersHorizontal } from "lucide-react";

/**
 * Settings' own side navigation (#99): sub-routes under `/settings`
 * (`router/routes.tsx`) rather than the one long-scrolling page it used to
 * be (`SettingsSection.tsx`, now split across the pages this nav links to).
 * Each destination is its own bounded, independently-scrolling pane (the
 * Bounded Pane Rule, `apps/client/DESIGN.md`) — this shell itself is the
 * `.app-viewport`-facing pane, laid out as a fixed nav rail beside whichever
 * page's `<Outlet/>` renders, mirroring the shape `mail/Sidebar.tsx` and
 * `mail/MailSection.tsx` already give the Mail App.
 *
 * A plain list of router `Link`s, not the shadcn `Sidebar` primitive: that
 * component brings a whole app-shell's worth of machinery (collapsible
 * rail, mobile sheet, cookie-persisted state) built for a *permanent*
 * navigation surface, and Mail's own folder rail — the Client's closest
 * precedent — is hand-rolled the same way. Six static links need none of
 * it; `Link`'s own active-match styling (`data-status="active"`) is what
 * highlights the current page.
 */

const NAV_ITEMS = [
  { to: "/settings/general", label: "General", Icon: SlidersHorizontal },
  { to: "/settings/this-device", label: "This device", Icon: Monitor },
  { to: "/settings/mail-accounts", label: "Mail Accounts", Icon: AtSign },
  { to: "/settings/gatekeeper", label: "Gatekeeper", Icon: ShieldCheck },
  { to: "/settings/notifications", label: "Notifications", Icon: Bell },
  { to: "/settings/security", label: "Security", Icon: Lock },
] as const;

export function SettingsLayout() {
  return (
    <div className="settings-shell">
      <nav className="settings-nav" aria-label="Settings">
        {NAV_ITEMS.map(({ to, label, Icon }) => (
          <Link key={to} to={to} className="settings-nav-item">
            <Icon size={15} />
            {label}
          </Link>
        ))}
      </nav>
      <div className="settings-content">
        <Outlet />
      </div>
    </div>
  );
}

import { Link, Outlet } from "@tanstack/react-router";
import { AtSign, Bell, Lock, Monitor, Server, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { rootRoute } from "../router/routes.js";
import "./settings.css";

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
 * rail, mobile sheet, cookie-persisted state) built for exactly the
 * collapse/Sheet behavior Mail's own folder rail (`mail/Sidebar.tsx`) does
 * use `Sidebar` for. Settings' rail has no such need — six static links,
 * never collapsed, no mobile sheet — so it stays the deliberate bordered
 * exception `apps/client/DESIGN.md` (Layout, and the "Don't reach for
 * shadcn `Sidebar` by default" rule) calls it. `Link`'s own active-match
 * styling (`data-status="active"`) is what highlights the current page.
 *
 * Instance (#104) is the one Owner-only entry: filtered out of `NAV_ITEMS`
 * for a Member entirely, per grill's "a Member gets no such nav entry"
 * rather than shown-then-blocked. `rootRoute.useRouteContext()` here is the
 * same seam `router/RootLayout.tsx` already reads `user` through — a
 * circular import with `router/routes.js` that resolves fine, since both
 * modules are fully evaluated before any component actually renders.
 */

const NAV_ITEMS = [
  { to: "/settings/general", label: "General", Icon: SlidersHorizontal },
  { to: "/settings/this-device", label: "This device", Icon: Monitor },
  { to: "/settings/mail-accounts", label: "Mail Accounts", Icon: AtSign },
  { to: "/settings/gatekeeper", label: "Gatekeeper", Icon: ShieldCheck },
  { to: "/settings/notifications", label: "Notifications", Icon: Bell },
  { to: "/settings/security", label: "Security", Icon: Lock },
] as const;

const OWNER_ONLY_NAV_ITEM = { to: "/settings/instance", label: "Instance", Icon: Server } as const;

export function SettingsLayout() {
  const { user } = rootRoute.useRouteContext();
  const navItems = user.role === "owner" ? [...NAV_ITEMS, OWNER_ONLY_NAV_ITEM] : NAV_ITEMS;

  return (
    <div className="settings-shell">
      <nav className="settings-nav" aria-label="Settings">
        {navItems.map(({ to, label, Icon }) => (
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

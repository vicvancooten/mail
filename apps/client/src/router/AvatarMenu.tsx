import { Link } from "@tanstack/react-router";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.js";
import { Avatar } from "../mail/Avatar.js";
import { type Theme, useAppearance } from "../theme/device-theme.js";

/**
 * The User's avatar menu (#72, part of #66): Settings and Appearance are
 * instance/device things, not Mail's own navigation ("Settings is reached
 * from the User's avatar menu, so instance-level things are not mixed into
 * Mail's own navigation" — the ticket's own words), so both live here
 * instead of the #71-era `.shell-nav` link this ticket retires.
 *
 * Since #86 it also names the signed-in User and their role. The comp's
 * header (`docs/design/prototypes/the-instrument.html`) carries no "Signed
 * in as …" line — the avatar *is* the identity, and the tile it renders is
 * drawn from the username, so it is the same mark in the same colour every
 * session. Who that avatar belongs to still has to be answerable, so the
 * menu it opens says it in words.
 *
 * Appearance is the same `useAppearance` control Settings' "This device"
 * page renders (`settings/ThisDeviceSection.tsx`, `theme/device-theme.ts`'s
 * own docstring) — one Device Preference, written from either place, read
 * by both. The header's own one-press light/dark toggle writes through the
 * same module (`useResolvedAppearance`), so this three-way group and that
 * button can never disagree.
 */
export function AvatarMenu({
  username,
  role,
  onLogout,
  signingOut,
}: {
  username: string;
  /** `"owner"` earns a badge in the menu — the one place the role is stated. */
  role?: string;
  onLogout: () => void;
  signingOut: boolean;
}) {
  const [theme, setTheme] = useAppearance();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="avatar-menu-trigger"
          aria-label={`Account menu for ${username}`}
        >
          <Avatar name={username} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="avatar-menu">
        <DropdownMenuLabel className="avatar-menu-identity">
          <span className="avatar-menu-name">{username}</span>
          {role === "owner" ? <span className="avatar-menu-role">Owner</span> : null}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/settings">Settings</Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Appearance</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={theme} onValueChange={(value) => setTheme(value as Theme)}>
          <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={signingOut}
          onSelect={(event) => {
            event.preventDefault();
            onLogout();
          }}
        >
          {signingOut ? "Logging out…" : "Log out"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

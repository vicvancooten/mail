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
 * Appearance is the same `useAppearance` control `SettingsSection` renders
 * (`theme/device-theme.ts`'s own docstring) — one Device Preference, written
 * from either place, read by both.
 */
export function AvatarMenu({
  username,
  onLogout,
  signingOut,
}: {
  username: string;
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

import {
  useListDensity,
  useSidebarCollapsed,
  useViewMode,
  type ViewMode,
} from "../mail/device-preferences.js";
import { type Theme, useAppearance } from "../theme/device-theme.js";

/**
 * Settings' "This device" page (#99, CONTEXT.md's Device Preference):
 * appearance, layout (Split/List), list density and the folder rail's
 * collapsed state — every one of them a Device Preference, deliberately
 * never synced, because each means something different on the next device
 * the User signs in from. The page states that plainly rather than leaving
 * it implicit, since every other Settings page *does* follow the User
 * everywhere.
 *
 * Each control is one of `mail/device-preferences.ts`'s reactive `use*`
 * hooks (the same shape `theme/device-theme.ts#useAppearance` already had) —
 * a change made here reaches `mail/MailSection.tsx` and `mail/Sidebar.tsx`
 * the instant it's written, and the reverse: the header's own Appearance
 * toggle and this page's copy can never disagree. Density in particular
 * used to have no reactive read at all (this ticket's own reason for
 * existing) — `MailSection`'s list updates immediately now.
 */
export function ThisDeviceSection() {
  const [theme, setTheme] = useAppearance();
  const [viewMode, setViewMode] = useViewMode();
  const [density, setDensity] = useListDensity();
  const [sidebarCollapsed, setSidebarCollapsed] = useSidebarCollapsed();

  return (
    <section className="settings-page">
      <h2>This device</h2>
      <p>
        These settings are stored on this device only — they never follow you to another computer or
        phone.
      </p>

      <section>
        <label>
          Appearance
          <select value={theme} onChange={(event) => setTheme(event.target.value as Theme)}>
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>

        <label>
          Layout
          <select
            value={viewMode}
            onChange={(event) => setViewMode(event.target.value as ViewMode)}
          >
            <option value="split">Split</option>
            <option value="list">List</option>
          </select>
        </label>

        <label>
          List density
          <select
            value={density}
            onChange={(event) => setDensity(event.target.value as "comfortable" | "compact")}
          >
            <option value="comfortable">Comfortable</option>
            <option value="compact">Compact</option>
          </select>
        </label>

        <label>
          <input
            type="checkbox"
            checked={sidebarCollapsed}
            onChange={(event) => setSidebarCollapsed(event.target.checked)}
          />
          Collapse the folder rail to icons
        </label>
      </section>
    </section>
  );
}

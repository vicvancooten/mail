import { type AppDef, appIconFor } from "./apps.js";

/**
 * The routed view for one of the three reserved Apps — Contacts, Calendar,
 * Tasks (#72, part of #66). "Finished chrome, not a stub" (the ticket's own
 * words): a name, one line of what the App will be, and a flat "Not built
 * yet" — no date, no waitlist, because neither would be true. The icon tile
 * is the comp's own `.ph-icon` (`docs/design/prototypes/the-instrument.html`)
 * — a rounded-square field-fill container the same App icon the Switcher's
 * tab row already carries, so a reserved App's placeholder isn't bare text.
 */
export function PlaceholderRoute({ app }: { app: AppDef }) {
  const Icon = appIconFor(app.key);
  return (
    <section className="app-placeholder" aria-label={app.name}>
      <div className="app-placeholder-card">
        <div className="app-placeholder-icon" aria-hidden="true">
          <Icon size={24} />
        </div>
        <h2>{app.name}</h2>
        <p>{app.description}</p>
        <p className="app-placeholder-status">Not built yet</p>
      </div>
    </section>
  );
}

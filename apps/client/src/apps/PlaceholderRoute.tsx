import type { AppDef } from "./apps.js";

/**
 * The routed view for one of the three reserved Apps — Contacts, Calendar,
 * Tasks (#72, part of #66). "Finished chrome, not a stub" (the ticket's own
 * words): a name, one line of what the App will be, and a flat "Not built
 * yet" — no date, no waitlist, because neither would be true.
 */
export function PlaceholderRoute({ app }: { app: AppDef }) {
  return (
    <section className="app-placeholder" aria-label={app.name}>
      <div className="app-placeholder-card">
        <h2>{app.name}</h2>
        <p>{app.description}</p>
        <p className="app-placeholder-status">Not built yet</p>
      </div>
    </section>
  );
}

/**
 * An empty routed view for one of the three placeholder Apps — Contacts,
 * Calendar, Tasks (#71, part of #66). Real URLs and a bounded pane are the
 * whole job here: the App switcher chrome and each app's actual placeholder
 * copy are the next ticket's, not this one's.
 */
export function PlaceholderRoute({ label }: { label: string }) {
  return <section className="app-placeholder" aria-label={label} />;
}

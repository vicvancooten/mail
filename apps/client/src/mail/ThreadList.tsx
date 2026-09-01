import { useThreadWindow } from "../store/index.js";

/**
 * Renders one (Mail Account, view) list window, newest first, from the Local
 * Cache alone — no network wait on this path, ever, which is what makes a
 * reload paint last state instantly and a cold boot with the backend down
 * show something real.
 */
export function ThreadList({ mailAccountId }: { mailAccountId: string }) {
  const page = useThreadWindow(mailAccountId);

  // The first read hasn't resolved yet — a frame or two, not a loading state.
  if (!page) return null;

  if (page.threads.length === 0) {
    return <p>No mail cached for this account yet.</p>;
  }

  return (
    <>
      <ul>
        {page.threads.map((thread) => (
          <li key={thread.id}>
            <strong>{thread.subject || "(no subject)"}</strong>
            <span> — {thread.participants.map(describeParticipant).join(", ")}</span>
            {thread.snippet ? <p>{thread.snippet}</p> : null}
            {thread.lastMessageAt ? (
              <time dateTime={thread.lastMessageAt}>
                {new Date(thread.lastMessageAt).toLocaleString()}
              </time>
            ) : null}
          </li>
        ))}
      </ul>
      {/* The window's one hole is always at the bottom (ADR-0009), so the list
          says where it ends rather than implying it reached the beginning. */}
      {page.complete ? null : <p>Older mail needs a connection.</p>}
    </>
  );
}

function describeParticipant(participant: { name: string | null; address: string }): string {
  return participant.name ?? participant.address;
}

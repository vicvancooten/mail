import type { NoteDocument } from "@mail/shared";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NoteEditor } from "./NoteEditor.js";

afterEach(() => {
  cleanup();
});

const DOCUMENT: NoteDocument = [
  {
    id: "b1",
    type: "paragraph",
    props: {},
    content: [{ type: "text", text: "Grocery list", styles: {} }],
    children: [],
  },
  {
    id: "b2",
    type: "checkListItem",
    props: { checked: true },
    content: [{ type: "text", text: "Milk", styles: {} }],
    children: [],
  },
];

const THREAD_LINK_DOCUMENT: NoteDocument = [
  {
    id: "b1",
    type: "threadLink",
    props: {
      threadId: "t1",
      subject: "Quarterly numbers",
      participants: "Ada Lovelace, Grace Hopper",
      date: "2026-06-25T09:00:00.000Z",
    },
    children: [],
  },
];

describe("NoteEditor", () => {
  it("renders a Note's content, editable by default", () => {
    const { container } = render(<NoteEditor document={DOCUMENT} />);

    expect(screen.getByText("Grocery list")).not.toBeNull();
    expect(screen.getByText("Milk")).not.toBeNull();

    const editable = container.querySelector('[contenteditable="true"]');
    expect(editable).not.toBeNull();
  });

  it("renders the same content read-only, from the same component — a Checklist's tick stays visible but un-interactive", () => {
    const { container } = render(<NoteEditor document={DOCUMENT} editable={false} />);

    expect(screen.getByText("Grocery list")).not.toBeNull();

    const checkbox = container.querySelector('input[type="checkbox"]');
    expect(checkbox).not.toBeNull();
    expect((checkbox as HTMLInputElement).checked).toBe(true);
    expect((checkbox as HTMLInputElement).disabled).toBe(true);

    expect(container.querySelector('[contenteditable="true"]')).toBeNull();
  });

  // Read-only only (#195): the editable branch wraps the chip in a router
  // `Link` (`thread-link-block.tsx`'s own doc comment) — every other test in
  // this file renders `<NoteEditor>` bare, with no `RouterProvider` above
  // it (this component "stays router-agnostic" the same way `MailSection`'s
  // own tests describe themselves), so exercising the clickable branch here
  // would mean building a router harness disproportionate to this one
  // block. The grid card's own read-only preview
  // (`NoteCard.tsx`, `note-text.test.ts`) and the wire round-trip
  // (`packages/shared/src/notes.test.ts`) cover the rest of the snapshot.
  it("renders a Thread Link's snapshot chip read-only — subject, participants, date, no live mail excerpt", () => {
    const { container } = render(<NoteEditor document={THREAD_LINK_DOCUMENT} editable={false} />);

    expect(screen.getByText("Quarterly numbers")).not.toBeNull();
    expect(screen.getByText(/Ada Lovelace, Grace Hopper/)).not.toBeNull();

    // Inert in the read-only preview — no anchor to Mail nested inside it
    // (`NoteCard.tsx`'s own "no interactive control nested in its own Link").
    expect(container.querySelector("a.thread-link")).toBeNull();
  });
});

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
});

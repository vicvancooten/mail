import type { Label } from "@mail/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotesLabelFilter } from "./NotesLabelFilter.js";

afterEach(() => {
  cleanup();
});

function label(id: string, name: string): Label {
  return { id, userId: "user-1", name, updatedAt: "2026-06-01T12:00:00.000Z" };
}

describe("NotesLabelFilter (#193)", () => {
  it("renders nothing when the User has no Labels", () => {
    const { container } = render(
      <NotesLabelFilter labels={[]} selectedLabelIds={new Set()} onToggle={vi.fn()} />,
    );

    expect(container.firstChild).toBeNull();
  });

  it("renders a chip per Label, alphabetized", () => {
    render(
      <NotesLabelFilter
        labels={[label("l2", "Work"), label("l1", "Home")]}
        selectedLabelIds={new Set()}
        onToggle={vi.fn()}
      />,
    );

    const chips = screen.getAllByRole("button");
    expect(chips.map((chip) => chip.textContent)).toEqual(["Home", "Work"]);
  });

  it("marks a selected chip aria-pressed, and toggling calls back with its id", () => {
    const onToggle = vi.fn();
    render(
      <NotesLabelFilter
        labels={[label("l1", "Home")]}
        selectedLabelIds={new Set(["l1"])}
        onToggle={onToggle}
      />,
    );

    const chip = screen.getByRole("button", { name: "Home" });
    expect(chip.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(chip);
    expect(onToggle).toHaveBeenCalledWith("l1");
  });
});

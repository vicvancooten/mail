import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Segmented } from "./Segmented.js";

afterEach(() => {
  cleanup();
});

const OPTIONS = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
] as const;

describe("Segmented (R2, #315)", () => {
  it("renders a radiogroup with one radio per option, the current one checked", () => {
    render(<Segmented options={OPTIONS} value="week" onChange={vi.fn()} label="View" />);

    expect(screen.getByRole("radiogroup", { name: "View" })).toBeTruthy();
    const radios = screen.getAllByRole("radio");
    expect(radios.map((radio) => radio.textContent)).toEqual(["Day", "Week", "Month"]);
    expect(screen.getByRole("radio", { name: "Week" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Day" }).getAttribute("aria-checked")).toBe("false");
  });

  it("clicking an option calls back with its value", () => {
    const onChange = vi.fn();
    render(<Segmented options={OPTIONS} value="day" onChange={onChange} label="View" />);

    fireEvent.click(screen.getByRole("radio", { name: "Month" }));
    expect(onChange).toHaveBeenCalledWith("month");
  });

  it("ArrowRight moves selection and focus to the next option, wrapping at the end", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <Segmented options={OPTIONS} value="month" onChange={onChange} label="View" />,
    );

    screen.getByRole("radio", { name: "Month" }).focus();
    fireEvent.keyDown(screen.getByRole("radiogroup"), { key: "ArrowRight" });

    expect(onChange).toHaveBeenCalledWith("day");
    rerender(<Segmented options={OPTIONS} value="day" onChange={onChange} label="View" />);
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Day" }));
  });

  it("ArrowLeft moves selection and focus to the previous option, wrapping at the start", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <Segmented options={OPTIONS} value="day" onChange={onChange} label="View" />,
    );

    screen.getByRole("radio", { name: "Day" }).focus();
    fireEvent.keyDown(screen.getByRole("radiogroup"), { key: "ArrowLeft" });

    expect(onChange).toHaveBeenCalledWith("month");
    rerender(<Segmented options={OPTIONS} value="month" onChange={onChange} label="View" />);
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Month" }));
  });

  it("only the checked option is in the Tab order", () => {
    render(<Segmented options={OPTIONS} value="week" onChange={vi.fn()} label="View" />);

    expect(screen.getByRole("radio", { name: "Day" }).getAttribute("tabindex")).toBe("-1");
    expect(screen.getByRole("radio", { name: "Week" }).getAttribute("tabindex")).toBe("0");
    expect(screen.getByRole("radio", { name: "Month" }).getAttribute("tabindex")).toBe("-1");
  });
});

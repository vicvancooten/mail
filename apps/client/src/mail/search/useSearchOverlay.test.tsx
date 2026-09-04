import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useSearchOverlay } from "./useSearchOverlay.js";

describe("useSearchOverlay", () => {
  it("starts inactive with an empty query", () => {
    const { result } = renderHook(() => useSearchOverlay());
    expect(result.current.active).toBe(false);
    expect(result.current.query).toBe("");
  });

  it("open() activates without touching the URL (#71: search has no route)", () => {
    const before = location.href;
    const { result } = renderHook(() => useSearchOverlay());

    act(() => result.current.open());

    expect(result.current.active).toBe(true);
    expect(location.href).toBe(before);
  });

  it("updateQuery and commitQuery both just set the query text", () => {
    const { result } = renderHook(() => useSearchOverlay());
    act(() => result.current.open());

    act(() => result.current.updateQuery("ab"));
    expect(result.current.query).toBe("ab");

    act(() => result.current.commitQuery("abc"));
    expect(result.current.query).toBe("abc");
  });

  it("leave() deactivates but the query survives, per the surface spec", () => {
    const { result } = renderHook(() => useSearchOverlay());
    act(() => result.current.open());
    act(() => result.current.commitQuery("report"));

    act(() => result.current.leave());

    expect(result.current.active).toBe(false);
    expect(result.current.query).toBe("report");
  });

  it("engage() runs the search without opening the results view (#100)", () => {
    const { result } = renderHook(() => useSearchOverlay());

    act(() => result.current.engage());

    expect(result.current.engaged).toBe(true);
    expect(result.current.active).toBe(false);
  });

  it("openResultsView() opens the results view for an already-engaged session (#100)", () => {
    const { result } = renderHook(() => useSearchOverlay());
    act(() => result.current.engage());

    act(() => result.current.openResultsView());

    expect(result.current.engaged).toBe(true);
    expect(result.current.active).toBe(true);
  });

  it("open() engages and opens the results view together", () => {
    const { result } = renderHook(() => useSearchOverlay());

    act(() => result.current.open());

    expect(result.current.engaged).toBe(true);
    expect(result.current.active).toBe(true);
  });
});

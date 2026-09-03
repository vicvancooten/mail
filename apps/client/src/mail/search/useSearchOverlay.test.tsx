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
});

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useSearchRoute } from "./useSearchRoute.js";

beforeEach(() => {
  history.replaceState(null, "", "/");
});

describe("useSearchRoute", () => {
  it("starts inactive at a plain path", () => {
    const { result } = renderHook(() => useSearchRoute());
    expect(result.current.active).toBe(false);
  });

  it("open() pushes /search and activates", () => {
    const { result } = renderHook(() => useSearchRoute());
    act(() => result.current.open());
    expect(result.current.active).toBe(true);
    expect(location.pathname).toBe("/search");
  });

  it("updateQuery replaces the URL without growing history", () => {
    const { result } = renderHook(() => useSearchRoute());
    act(() => result.current.open());
    const lengthAfterOpen = history.length;
    act(() => result.current.updateQuery("a"));
    act(() => result.current.updateQuery("ab"));
    expect(history.length).toBe(lengthAfterOpen);
    expect(new URLSearchParams(location.search).get("q")).toBe("ab");
  });

  it("commitQuery pushes a checkpoint entry", () => {
    const { result } = renderHook(() => useSearchRoute());
    act(() => result.current.open());
    const lengthAfterOpen = history.length;
    act(() => result.current.commitQuery("report"));
    expect(history.length).toBe(lengthAfterOpen + 1);
  });

  it("leave() (Back) deactivates and a real popstate updates the hook", async () => {
    const { result } = renderHook(() => useSearchRoute());
    act(() => result.current.open());
    expect(result.current.active).toBe(true);

    act(() => result.current.leave());

    await waitFor(() => expect(result.current.active).toBe(false));
    expect(location.pathname).toBe("/");
  });
});

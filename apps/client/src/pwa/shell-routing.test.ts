import { describe, expect, it } from "vitest";
import { isApiPath, manifestFingerprint } from "./shell-routing.js";

describe("isApiPath", () => {
  it.each([
    "/sync",
    "/sync/threads",
    "/auth",
    "/auth/login",
    "/healthz",
    "/instance",
    "/instance/health",
  ])("flags %s as an API path the service worker must never touch", (pathname) => {
    expect(isApiPath(pathname)).toBe(true);
  });

  it.each(["/", "/index.html", "/assets/index-abc123.js", "/search", "/manifest.webmanifest"])(
    "treats %s as a shell path",
    (pathname) => {
      expect(isApiPath(pathname)).toBe(false);
    },
  );
});

describe("manifestFingerprint", () => {
  it("is stable for the same entries regardless of input order", () => {
    const a = manifestFingerprint([
      { url: "index.html", revision: "abc" },
      { url: "assets/app.js", revision: "def" },
    ]);
    const b = manifestFingerprint([
      { url: "assets/app.js", revision: "def" },
      { url: "index.html", revision: "abc" },
    ]);
    expect(a).toBe(b);
  });

  it("changes when a revision changes, so a new build gets a new shell cache", () => {
    const before = manifestFingerprint([{ url: "assets/app.js", revision: "def" }]);
    const after = manifestFingerprint([{ url: "assets/app.js", revision: "ghi" }]);
    expect(before).not.toBe(after);
  });

  it("changes when an asset is added or removed", () => {
    const smaller = manifestFingerprint([{ url: "assets/app.js", revision: "def" }]);
    const larger = manifestFingerprint([
      { url: "assets/app.js", revision: "def" },
      { url: "assets/app.css", revision: "xyz" },
    ]);
    expect(smaller).not.toBe(larger);
  });

  it("never returns an empty string, even for an empty manifest", () => {
    expect(manifestFingerprint([])).toBe("empty");
  });
});

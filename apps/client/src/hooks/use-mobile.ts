import * as React from "react";

const MOBILE_BREAKPOINT = 768;

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined);

  React.useEffect(() => {
    // Optional, not a bug: jsdom (this repo's test environment) has no
    // `matchMedia` at all — same "best-effort, falls back to a default"
    // posture `theme/device-theme.ts`'s own media query read already takes.
    const mql = window.matchMedia?.(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    };
    mql?.addEventListener("change", onChange);
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    return () => mql?.removeEventListener("change", onChange);
  }, []);

  return !!isMobile;
}

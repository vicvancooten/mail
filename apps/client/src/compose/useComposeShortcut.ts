import { useEffect } from "react";

/**
 * The `c` → Compose shortcut (compose-spec §Composer surface & keys).
 * `r`/`a`/`f` (reply / reply-all / forward) are #47's — they need a message
 * to reply to, which this ticket's "new compose" entry point does not have.
 * Suppressed while a composer is already open: "one composer at a time"
 * means a second `c` while one is open does nothing, matching how
 * `useTriage`'s own shortcuts go inert for the same reason.
 */
export function useComposeShortcut(onCompose: () => void, disabled: boolean): void {
  useEffect(() => {
    if (disabled) return;

    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (typing) return;

      if (event.key === "c") {
        event.preventDefault();
        onCompose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCompose, disabled]);
}

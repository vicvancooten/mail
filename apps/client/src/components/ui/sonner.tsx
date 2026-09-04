import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type * as React from "react";
import { Toaster as Sonner, type ToasterProps } from "sonner";
import { useResolvedAppearance } from "@/theme/device-theme";

/**
 * shadcn's own `Toaster`, adapted from the next-themes-driven original to
 * this app's Device Preference theme (`theme/device-theme.ts`) — the same
 * `useResolvedAppearance` the header's toggle and `AvatarMenu` read, so a
 * toast never disagrees with the chrome around it. Mounted once in
 * `RootLayout`, above `<Outlet />`, so a toast can be raised from any
 * route — including `/settings` (#93's acceptance box) — not just from
 * inside Mail.
 */
const Toaster = ({ ...props }: ToasterProps) => {
  const [resolvedDark] = useResolvedAppearance();

  return (
    <Sonner
      theme={resolvedDark ? "dark" : "light"}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius-panel)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "shadow-[var(--shadow-overlay)]!",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };

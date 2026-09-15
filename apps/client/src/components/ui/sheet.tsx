import { XIcon } from "lucide-react";
import { Dialog as SheetPrimitive } from "radix-ui";
import type * as React from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function Sheet({ ...props }: React.ComponentProps<typeof SheetPrimitive.Root>) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

function SheetTrigger({ ...props }: React.ComponentProps<typeof SheetPrimitive.Trigger>) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

function SheetClose({ ...props }: React.ComponentProps<typeof SheetPrimitive.Close>) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

function SheetPortal({ ...props }: React.ComponentProps<typeof SheetPrimitive.Portal>) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />;
}

function SheetOverlay({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Overlay>) {
  return (
    <SheetPrimitive.Overlay
      data-slot="sheet-overlay"
      className={cn(
        // R5 (`docs/design/polish-pass.md`): the scrim fades over
        // `--dur-fast` in both directions.
        "fixed inset-0 z-50 bg-black/20 supports-backdrop-filter:backdrop-blur-xs data-open:animate-[sheet-scrim-in_var(--dur-fast)_linear] data-closed:animate-[sheet-scrim-out_var(--dur-fast)_linear]",
        className,
      )}
      {...props}
    />
  );
}

function SheetContent({
  className,
  children,
  side = "right",
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content> & {
  side?: "top" | "right" | "bottom" | "left";
  showCloseButton?: boolean;
}) {
  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Content
        data-slot="sheet-content"
        data-side={side}
        className={cn(
          "fixed z-50 flex flex-col gap-4 bg-popover bg-clip-padding text-sm text-popover-foreground shadow-[var(--shadow-overlay)] data-[side=bottom]:inset-x-0 data-[side=bottom]:bottom-0 data-[side=bottom]:h-auto data-[side=bottom]:rounded-t-[var(--radius-panel)] data-[side=left]:inset-y-0 data-[side=left]:left-0 data-[side=left]:h-full data-[side=left]:w-3/4 data-[side=left]:border-r data-[side=right]:inset-y-0 data-[side=right]:right-0 data-[side=right]:h-full data-[side=right]:w-3/4 data-[side=right]:border-l data-[side=top]:inset-x-0 data-[side=top]:top-0 data-[side=top]:h-auto data-[side=top]:border-b data-[side=left]:sm:max-w-sm data-[side=right]:sm:max-w-sm",
          // Left/right/top keep the shared `tw-animate-css` slide-in/out —
          // only the bottom side's motion is a named direction the spec
          // (R5) gives its own curve and duration to.
          "data-[side=left]:transition data-[side=left]:duration-200 data-[side=left]:ease-in-out data-[side=left]:data-open:animate-in data-[side=left]:data-open:fade-in-0 data-[side=left]:data-open:slide-in-from-left-10 data-[side=left]:data-closed:animate-out data-[side=left]:data-closed:fade-out-0 data-[side=left]:data-closed:slide-out-to-left-10",
          "data-[side=right]:transition data-[side=right]:duration-200 data-[side=right]:ease-in-out data-[side=right]:data-open:animate-in data-[side=right]:data-open:fade-in-0 data-[side=right]:data-open:slide-in-from-right-10 data-[side=right]:data-closed:animate-out data-[side=right]:data-closed:fade-out-0 data-[side=right]:data-closed:slide-out-to-right-10",
          "data-[side=top]:transition data-[side=top]:duration-200 data-[side=top]:ease-in-out data-[side=top]:data-open:animate-in data-[side=top]:data-open:fade-in-0 data-[side=top]:data-open:slide-in-from-top-10 data-[side=top]:data-closed:animate-out data-[side=top]:data-closed:fade-out-0 data-[side=top]:data-closed:slide-out-to-top-10",
          // R5 (`docs/design/polish-pass.md`, "Sheet rise"): the bottom
          // sheet gets its own two keyframes (`shell.css`'s `sheet-rise`/
          // `sheet-fall`) instead of `tw-animate-css`'s generic
          // slide-in-from-bottom-10 — enter rides `--dur-leave` (the
          // "something arriving" budget), exit is the quick `--dur-fast`
          // every other dismissal uses.
          "data-[side=bottom]:data-open:animate-[sheet-rise_var(--dur-leave)_var(--ease-out)] data-[side=bottom]:data-closed:animate-[sheet-fall_var(--dur-fast)_var(--ease-out)]",
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <SheetPrimitive.Close data-slot="sheet-close" asChild>
            <Button variant="ghost" className="absolute top-3 right-3" size="icon-sm">
              <XIcon />
              <span className="sr-only">Close</span>
            </Button>
          </SheetPrimitive.Close>
        )}
      </SheetPrimitive.Content>
    </SheetPortal>
  );
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("flex flex-col gap-0.5 p-4", className)}
      {...props}
    />
  );
}

function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn("mt-auto flex flex-col gap-2 p-4", className)}
      {...props}
    />
  );
}

function SheetTitle({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn("font-heading text-base font-medium text-foreground", className)}
      {...props}
    />
  );
}

function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
};

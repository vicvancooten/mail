import type { ReactNode } from "react";

/**
 * Shared field chrome for claim/login/TOTP — three forms with an identical
 * label-over-input shape and the same inline error slip, so the shape lives
 * once rather than being retyped per form.
 */
export function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label
        htmlFor={htmlFor}
        className="text-[10px] font-semibold tracking-[0.11em] text-muted-foreground uppercase"
      >
        {label}
      </label>
      {children}
    </div>
  );
}

export const inputClassName =
  "w-full rounded-[var(--radius-md)] border border-input bg-background px-3 py-2 text-sm text-foreground transition-colors outline-none placeholder:text-muted-foreground hover:border-ring/50 focus-visible:border-ring";

export function FormError({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="m-0 rounded-[var(--radius-md)] border border-destructive/40 bg-destructive/10 px-3 py-2 text-[13px] text-destructive"
    >
      {children}
    </p>
  );
}

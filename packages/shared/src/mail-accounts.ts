import { z } from "zod";

/**
 * How a connection's transport is secured. `tls` is implicit TLS on connect
 * (e.g. IMAP 993 / SMTP 465); `starttls` connects in the clear and upgrades;
 * `none` never encrypts — only reachable through manual entry, for dev
 * servers like GreenMail (docs/dev-setup.md).
 */
export const mailAccountSecuritySchema = z.enum(["tls", "starttls", "none"]);
export type MailAccountSecurity = z.infer<typeof mailAccountSecuritySchema>;

export const mailAccountConnectionSchema = z.object({
  host: z.string().trim().min(1, "Host is required"),
  port: z.int().min(1).max(65535),
  security: mailAccountSecuritySchema,
});
export type MailAccountConnection = z.infer<typeof mailAccountConnectionSchema>;

/**
 * `active` syncs normally. `needs_reauth` (CONTEXT.md) is what a rejected
 * credential parks the Mail Account in: syncing stops, queued Optimistic
 * Actions hold, and re-entering credentials resumes.
 */
export const mailAccountStatusSchema = z.enum(["active", "needs_reauth"]);
export type MailAccountStatus = z.infer<typeof mailAccountStatusSchema>;

/**
 * Where the resident sync loop (#35, `sync/live-session.ts`) is, distinct
 * from `status` (the credential verdict): `stopped` before it has ever run
 * or after `Needs Reauth` parks it, `connecting`/`syncing` while it opens the
 * connection and catches the folder up, `idle` once it is holding IDLE (or
 * waiting on its next poll), `error` between a drop and its self-restart.
 * This is the groundwork for ADR-0015's two-tier liveness — a per-account
 * staleness banner reads `lastProgressAt` against this, not `status`.
 */
export const mailAccountSyncStateSchema = z.enum([
  "stopped",
  "connecting",
  "syncing",
  "idle",
  "error",
]);
export type MailAccountSyncState = z.infer<typeof mailAccountSyncStateSchema>;

export const mailAccountSyncSchema = z.object({
  state: mailAccountSyncStateSchema,
  /** Stamped on every IDLE keepalive or completed poll — null before the first one. */
  lastProgressAt: z.iso.datetime().nullable(),
  /** The last error's message, kept only while `state` is `error`; cleared on the next success. */
  lastError: z.string().nullable(),
});
export type MailAccountSync = z.infer<typeof mailAccountSyncSchema>;

/**
 * The Index Watermark (CONTEXT.md, #36): how far back this Mail Account's
 * message bodies have been fetched and indexed. Headers are searchable from
 * the first sync regardless; this is what lets the Client state partial body
 * coverage rather than silently searching (or previewing) too little.
 * `coveredSince` is null until the background sweep has completed at least
 * one batch; `complete` is true once it has swept every folder's history —
 * the sweep's "runs once and then stops".
 */
export const indexWatermarkSchema = z.object({
  coveredSince: z.iso.datetime().nullable(),
  complete: z.boolean(),
});
export type IndexWatermark = z.infer<typeof indexWatermarkSchema>;

/**
 * The wire projection of a Mail Account. Credentials are write-only across
 * the API (ADR-0003) — this shape has no field for them, ever, not even a
 * masked one; the Client shows "password set" from `status` alone.
 */
export const mailAccountSchema = z.object({
  id: z.string(),
  emailAddress: z.string(),
  imap: mailAccountConnectionSchema,
  smtp: mailAccountConnectionSchema,
  status: mailAccountStatusSchema,
  sync: mailAccountSyncSchema,
  indexWatermark: indexWatermarkSchema,
  /**
   * The plain-text signature (compose-spec §Signature, poc-scope.md): one
   * per Mail Account, null until the User sets one. #54 (Preferences) grows
   * this into the general Mail-Account-scoped preference collection; this is
   * the inline column it will read from — the same "one value ahead of its
   * own ticket" shape `compose.ts`'s `UNDO_SEND_DELAY_OPTIONS` already uses.
   */
  signature: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type MailAccount = z.infer<typeof mailAccountSchema>;

/** `PATCH /mail-accounts/:id/signature` — a plain-text signature, or `null` to clear it. */
export const updateMailAccountSignatureRequestSchema = z.object({
  signature: z.string().nullable(),
});
export type UpdateMailAccountSignatureRequest = z.infer<
  typeof updateMailAccountSignatureRequestSchema
>;

export const mailAccountListResponseSchema = z.object({
  mailAccounts: z.array(mailAccountSchema),
});
export type MailAccountListResponse = z.infer<typeof mailAccountListResponseSchema>;

export const discoverMailAccountRequestSchema = z.object({
  emailAddress: z.email(),
});
export type DiscoverMailAccountRequest = z.infer<typeof discoverMailAccountRequestSchema>;

/** Which step of the autodiscover chain (poc-spec.md §Mail Accounts) produced a hit. */
export const autodiscoverSourceSchema = z.enum(["autoconfig", "well-known", "srv", "ispdb"]);
export type AutodiscoverSource = z.infer<typeof autodiscoverSourceSchema>;

/**
 * `found: false` still carries `prefill` when the domain's MX resolves to
 * `mx1`/`mx2.privateemail.com` (docs/research/0004 §4) — manual entry is a
 * first-class step, not an apologetic dead end.
 */
export const discoverMailAccountResponseSchema = z.discriminatedUnion("found", [
  z.object({
    found: z.literal(true),
    source: autodiscoverSourceSchema,
    imap: mailAccountConnectionSchema,
    smtp: mailAccountConnectionSchema,
  }),
  z.object({
    found: z.literal(false),
    prefill: z
      .object({ imap: mailAccountConnectionSchema, smtp: mailAccountConnectionSchema })
      .nullable(),
  }),
]);
export type DiscoverMailAccountResponse = z.infer<typeof discoverMailAccountResponseSchema>;

/**
 * Adding a Mail Account is verify-then-save (poc-spec.md): this request
 * carries everything needed for a live IMAP+SMTP check before a row ever
 * exists. `username` is the IMAP/SMTP login, which isn't always
 * `emailAddress` (e.g. GreenMail's dynamic accounts, some shared hosting).
 */
export const createMailAccountRequestSchema = z.object({
  emailAddress: z.email(),
  imap: mailAccountConnectionSchema,
  smtp: mailAccountConnectionSchema,
  username: z.string().trim().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
});
export type CreateMailAccountRequest = z.infer<typeof createMailAccountRequestSchema>;

/** Re-enters credentials against the Mail Account's existing host/port/TLS config. */
export const reauthMailAccountRequestSchema = z.object({
  username: z.string().trim().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
});
export type ReauthMailAccountRequest = z.infer<typeof reauthMailAccountRequestSchema>;

export const mailAccountResponseSchema = z.object({ mailAccount: mailAccountSchema });
export type MailAccountResponse = z.infer<typeof mailAccountResponseSchema>;

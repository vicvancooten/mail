import { z } from "zod";

/**
 * Where a Calendar or Address Book comes from (CONTEXT.md's **Origin**):
 * exactly one Connected Account, whose upstream it mirrors, or Local. Every
 * Event and Contact takes the Origin of its own collection and never
 * carries one of its own (CONTEXT.md: "Every Event and Contact takes the
 * Origin of its collection and never has one of its own") — this schema is
 * for the collection itself (`address-books.ts#addressBookSchema`, and
 * later Calendar's own row), not for the rows inside it.
 *
 * A discriminated union rather than a bare nullable `connectedAccountId`
 * because "Local" is a first-class state (ADR-0026: "created by the User,
 * never synced, never Needs Reauth"), not the absence of one.
 */
export const originSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local") }),
  z.object({ kind: z.literal("connectedAccount"), connectedAccountId: z.string() }),
]);
export type Origin = z.infer<typeof originSchema>;

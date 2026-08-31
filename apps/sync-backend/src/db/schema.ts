import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Placeholder table proving the migration path end-to-end. The real schema
 * (User, Mail Account, Thread, Message, ...) lands with the tickets that
 * design each of those, not here.
 */
export const scaffoldProbe = pgTable("scaffold_probe", {
  id: text("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

import { DEFAULT_TASK_LIST_NAME, defaultTaskListId } from "@mail/shared";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { taskLists } from "../db/schema.js";

/**
 * Seeds a User's default Task List (#251, ADR-0030's "exactly one Origin",
 * the ticket's own "The default Task List ... is seeded server-side on
 * first sync of the collection, not by the Client on first render, so two
 * devices opening the App at once cannot mint two of them").
 *
 * Idempotent by a **deterministic id** (`@mail/shared#defaultTaskListId`)
 * rather than a lock or an extra unique index: two requests racing this same
 * User both attempt the identical insert, `onConflictDoNothing` lets exactly
 * one of them land, and the loser simply reads back what the winner wrote.
 * Called on every `TaskList` sync (`collection-registry.ts`'s own
 * `selectRows`), not gated on "this is the User's first ever request" — the
 * insert is cheap and a no-op past the first call, which is what "seeded on
 * first sync" collapses to once there is nothing left to seed.
 */
export async function ensureDefaultTaskList(db: Db, userId: string): Promise<void> {
  const id = defaultTaskListId(userId);
  const [existing] = await db
    .select({ id: taskLists.id })
    .from(taskLists)
    .where(and(eq(taskLists.id, id), eq(taskLists.userId, userId)))
    .limit(1);
  if (existing) return;

  await db
    .insert(taskLists)
    .values({
      id,
      userId,
      name: DEFAULT_TASK_LIST_NAME,
      sections: [],
      isDefault: true,
      order: 0,
    })
    .onConflictDoNothing({ target: taskLists.id });
}

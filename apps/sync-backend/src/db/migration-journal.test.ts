import { describe, expect, it } from "vitest";
import journal from "./migrations/meta/_journal.json" with { type: "json" };

function pairwise<T>(items: readonly T[]): Array<[T, T]> {
  const pairs: Array<[T, T]> = [];
  for (let i = 1; i < items.length; i++) {
    const previous = items[i - 1];
    const current = items[i];
    if (previous !== undefined && current !== undefined) {
      pairs.push([previous, current]);
    }
  }
  return pairs;
}

// Regression test for the 0036_luxuriant_calypso incident: a commit bumped
// that entry's `when` to one millisecond above 0047's to paper over a
// migration being skipped on one developer's machine. Because drizzle's
// postgres-js migrator gates a full replay on a single
// `MAX(created_at) < entry.when` comparison (not a per-migration hash
// lookup), raising a `when` above an already-applied sibling makes that
// migration look unapplied again — re-running its SQL inside the same
// transaction as every migration after it, aborting all of them the moment
// the re-run statement collides with a column/table that already exists.
// Editing an existing entry's `when` (or `tag`) is exactly the move that
// caused it; new migrations must only ever be appended with a higher `when`
// than everything before them.
describe("migration journal", () => {
  it("orders entries by idx starting at 0 with no gaps or duplicates", () => {
    journal.entries.forEach((entry, i) => {
      expect(entry.idx).toBe(i);
    });
  });

  it("has a strictly increasing `when` across entries", () => {
    for (const [previous, current] of pairwise(journal.entries)) {
      expect(
        current.when,
        `${current.tag} (idx ${current.idx}, when ${current.when}) must be greater than ` +
          `${previous.tag} (idx ${previous.idx}, when ${previous.when}); ` +
          "lowering it skips the migration forever on databases that already applied " +
          "later ones, raising it above an already-applied sibling re-runs its SQL",
      ).toBeGreaterThan(previous.when);
    }
  });
});

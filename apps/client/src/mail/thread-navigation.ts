import type { CachedThread } from "../store/index.js";

/** Small id-array helpers shared by every view's prev/next and chevron logic. */

export function neighborId(
  ids: readonly string[],
  currentId: string | null,
  delta: number,
): string | null {
  if (ids.length === 0) return null;
  const currentIndex = currentId ? ids.indexOf(currentId) : -1;
  if (currentIndex === -1) return ids[0] ?? null;
  const nextIndex = currentIndex + delta;
  if (nextIndex < 0 || nextIndex >= ids.length) return null;
  return ids[nextIndex] ?? null;
}

export function findThread(
  threads: readonly CachedThread[],
  id: string | null,
): CachedThread | null {
  if (id === null) return null;
  return threads.find((thread) => thread.id === id) ?? null;
}

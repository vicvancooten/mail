/**
 * The `store` module: the only code in the Client that imports Dexie
 * (ADR-0010). Its surface is deliberately four separate things, and which
 * one you may call depends on what you are:
 *
 * - **Components** read through the hooks in `reads.ts`, pin opened Threads
 *   through `cache-pins.ts`, and queue an Optimistic Action through
 *   `enqueueMutation` (`mutation-queue.ts`). That is all they may touch.
 * - **`sync/`** — and nothing else — writes base rows and reads state tokens
 *   through `server-writes.ts`, and flushes the Optimistic Action queue
 *   through `mutation-queue.ts`'s other two exports.
 * - **Boot** opens the cache through `local-cache.ts`.
 *
 * The point of the seam is not testability: it is that the wrong move
 * ("just write to the table") isn't reachable from a component.
 */

export {
  materializeSearchResultThread,
  pinThreadIntoCache,
  unpinThreadFromCache,
} from "./cache-pins.js";
export {
  type ComposeContent,
  type ComposeSaveConflict,
  EMPTY_COMPOSE_CONTENT,
  newCompositionId,
  recordAttachmentRemoved,
  recordAttachmentUploaded,
  requestCancelSend,
  saveComposition,
  sendComposition,
  subscribeComposeConflicts,
  undoSecondsRemaining,
  useComposition,
  useDraftCompositions,
  useFailedSends,
  usePendingSends,
} from "./compositions.js";
export {
  CACHE_SCHEMA_VERSION,
  type CachedComposition,
  type CachedThread,
  type CacheSchemaOutcome,
  DEFAULT_VIEW,
  type ListWindow,
  type PendingMutation,
  type PendingUserMutation,
  type ViewKey,
} from "./db.js";
export {
  ensureLocalCacheOpen,
  type OpenLocalCacheOptions,
  openLocalCache,
  reconcileCacheSchema,
} from "./local-cache.js";
export {
  enqueueMutation,
  listQueuedMutations,
  type MutationRejection,
  resolveMutationOutcomes,
  subscribeMutationRejections,
} from "./mutation-queue.js";
export {
  readCorrespondents,
  readLabels,
  readMailAccounts,
  readPreference,
  readScreenerSenders,
  readSearchPrefilter,
  readThreadWindow,
  type ScreenerAccountGroup,
  type ScreenerSenderGroup,
  type SearchPrefilterFilters,
  THREAD_PAGE_SIZE,
  type ThreadWindowPage,
  useCorrespondents,
  useLabels,
  useMailAccounts,
  usePreference,
  useScreenerSenders,
  useSearchPrefilter,
  useSearchResultThreads,
  useThreadWindow,
} from "./reads.js";
export {
  enqueueUserMutation,
  listQueuedUserMutations,
  resolveUserMutationOutcomes,
} from "./user-mutation-queue.js";

import { useEffect } from "react";
import { useAuth } from "../auth/AuthContext.js";
import { ensureLocalCacheOpen } from "../store/index.js";
import { type SyncLoopHandle, startSyncLoop } from "./sync-loop.js";

/**
 * Opens the Local Cache and, if this tab wins the Web Lock, runs the sync
 * loop for as long as the component is mounted. Deliberately returns
 * nothing: the UI renders from the cache (ADR-0010), never from what this
 * happens to be doing.
 */
export function useLocalCacheSync(): void {
  const { handleUnauthorized } = useAuth();

  useEffect(() => {
    let handle: SyncLoopHandle | null = null;
    let unmounted = false;

    void ensureLocalCacheOpen()
      .then(() => {
        if (unmounted) return;
        handle = startSyncLoop({ onUnauthorized: handleUnauthorized });
      })
      // A cache that will not open leaves the Client with nothing to render
      // and nothing to sync into; there is no useful recovery from here, and
      // shouting about it would be the opposite of silent-when-healthy.
      .catch(() => {});

    return () => {
      unmounted = true;
      handle?.stop();
    };
  }, [handleUnauthorized]);
}

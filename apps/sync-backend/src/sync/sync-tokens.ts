/**
 * The delta sync API's (#37, ADR-0011) opaque state token: a base64url blob
 * the Client round-trips without ever constructing or inspecting it. Encodes
 * a cursor into the shared `sync_rev_seq` revision order
 * (`sync/tombstones.ts`, `db/schema.ts`) plus, for a collection whose
 * underlying state can be rebuilt out from under it, the epoch that cursor
 * was issued under.
 */

const TOKEN_VERSION = 1;

export interface SyncCursor {
  /** Position in the shared revision order — see `mailAccounts.syncRev`. */
  rev: number;
  /** Present only for a collection that tracks a rebuild epoch (Thread). */
  epoch?: number;
}

interface DecodedTokenPayload {
  v: number;
  rev: number;
  epoch?: number;
}

export function encodeSyncToken(cursor: SyncCursor): string {
  const payload: DecodedTokenPayload = {
    v: TOKEN_VERSION,
    rev: cursor.rev,
    ...(cursor.epoch !== undefined ? { epoch: cursor.epoch } : {}),
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/**
 * Decodes a Client-supplied token. `null` on anything this server doesn't
 * recognize as its own — wrong version, malformed base64/JSON, a `rev` that
 * isn't a non-negative integer — which `collection-sync.ts` treats exactly
 * like the "token too old" reset case (ADR-0011): there is no daylight
 * between "I don't know this token" and "I no longer trust this token".
 */
export function decodeSyncToken(token: string): SyncCursor | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (typeof decoded !== "object" || decoded === null) return null;
  const payload = decoded as Partial<DecodedTokenPayload>;
  if (payload.v !== TOKEN_VERSION) return null;
  if (typeof payload.rev !== "number" || !Number.isInteger(payload.rev) || payload.rev < 0) {
    return null;
  }
  if (
    payload.epoch !== undefined &&
    (typeof payload.epoch !== "number" || !Number.isInteger(payload.epoch))
  ) {
    return null;
  }

  return { rev: payload.rev, epoch: payload.epoch };
}

export interface ResolvedCursor {
  /** `-1` sentinel: strictly below every real revision (which start at 0), so `rev > cursor` matches everything on a bootstrap. */
  rev: number;
  /** True when the Client must discard this collection rather than merge the page in. */
  needsReset: boolean;
}

/**
 * Turns a requested token (`null` = bootstrap, a string = resume) into the
 * cursor `collection-sync.ts` queries from, plus whether this round's
 * response must carry `reset: true`. `currentEpoch` is omitted for a
 * collection with no rebuild-epoch concept (MailAccount).
 */
export function resolveCursor(token: string | null, currentEpoch?: number): ResolvedCursor {
  if (token === null) return { rev: -1, needsReset: false };

  const decoded = decodeSyncToken(token);
  if (!decoded) return { rev: -1, needsReset: true };
  if (currentEpoch !== undefined && decoded.epoch !== currentEpoch) {
    return { rev: -1, needsReset: true };
  }
  return { rev: decoded.rev, needsReset: false };
}

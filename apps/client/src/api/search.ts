import { type SearchRequest, type SearchResponse, searchResponseSchema } from "@mail/shared";
import { postJson } from "./auth.js";

/**
 * `POST /search` (#50, #51, ADR-0016). Deliberately outside `POST /sync`'s
 * delta protocol — a stateless query, not a synced collection — so this is
 * a plain authenticated `POST` like `api/messages.ts`'s Message reads, not
 * another entry in `sync/`.
 */
export function runServerSearch(request: SearchRequest): Promise<SearchResponse> {
  return postJson("/search", request, (data) => searchResponseSchema.parse(data));
}

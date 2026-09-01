import { type Correspondent, correspondentSearchResponseSchema } from "@mail/shared";
import { getJson } from "./auth.js";

/**
 * The long-tail half of recipient autocomplete (#49, compose-spec
 * §Recipient autocomplete): the Client's synced top ~500 Correspondents
 * answer the first keystroke instantly and locally
 * (`store/reads.ts#useCorrespondents`); this queries the Sync Backend for
 * every Correspondent this Mail Account has ever had, for a query the local
 * set misses. Callers run it in parallel with the local match, never
 * instead of it.
 */
export function searchCorrespondents(
  mailAccountId: string,
  query: string,
): Promise<Correspondent[]> {
  const params = new URLSearchParams({ mailAccountId, q: query });
  return getJson(`/correspondents/search?${params.toString()}`, (data) => {
    return correspondentSearchResponseSchema.parse(data).correspondents;
  });
}

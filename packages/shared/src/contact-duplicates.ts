import type { Contact } from "./contacts.js";
import { normalizeCorrespondentAddress } from "./correspondents.js";

/**
 * Duplicate detection (#222, ADR-0026: "Duplicate detection suggests, never
 * acts"). Two Contacts are a **possible** duplicate when they share a
 * normalised email address or a shared E.164 phone number across the
 * Contacts in Account Scope — never when they merely share a name, which
 * this ticket's own acceptance line rules out outright ("too many false
 * pairs to be worth a chip": every "John Smith" in a mirrored corporate
 * directory would pair with every other one).
 *
 * Deliberately a pure function over the whole-replicated collection rather
 * than a stored join or a server-side sweep — the same "a search, not a
 * stored join" posture the Person Page's own Mail history takes (#217).
 * There is no `Duplicate` row anywhere: the chip and the grid filter are
 * both recomputed from whatever Contacts the Client currently holds, so a
 * Contact edited into or out of a pair stops being a suggestion the instant
 * the edit lands, with nothing to invalidate.
 */

/**
 * How many digits a phone number needs before it can pair two Contacts at
 * all. An extension ("204"), a short code ("112") or a partially-entered
 * number would otherwise pair every Contact that happens to hold it; seven
 * is the shortest a real subscriber number runs to in the national plans
 * this app's Users actually live in.
 */
const MIN_PHONE_DIGITS = 7;

/**
 * A Contact's email address reduced to what two records must share to be
 * the same address — `normalizeCorrespondentAddress`'s own case-insensitive,
 * trimmed rule, reused verbatim so "the same address" means one thing across
 * Mail and Contacts rather than two subtly different things. `null` for a
 * value that isn't an address at all (blank, or no `@`): an unusable value
 * never pairs, rather than pairing every other Contact that also left the
 * field half-filled.
 */
export function contactEmailMatchKey(value: string): string | null {
  const normalized = normalizeCorrespondentAddress(value);
  const at = normalized.indexOf("@");
  if (at <= 0 || at === normalized.length - 1) return null;
  return normalized;
}

/**
 * A Contact's phone number reduced to its E.164 form where the value
 * actually carries one (ADR-0026: "a shared E.164 phone number"):
 * punctuation and spacing dropped, a leading `+` kept, and a leading `00`
 * — the international access prefix in most of the world — folded onto the
 * same `+` key so `0031612345678` and `+31612345678` pair.
 *
 * A number entered in **national** format (`06 12345678`) keys on its bare
 * digits instead, which pairs it with another national-format copy of itself
 * but *not* with its own `+`-prefixed form: turning `0612345678` into
 * `+31612345678` needs a default region, and this app holds no region
 * preference to infer one from (`Preference.homeTimeZone` is a zone, not a
 * country — and a zone is not a dialling plan). That gap is a missed
 * suggestion, never a wrong one, which is the right way round for a feature
 * whose whole posture is "suggests, never acts"; a real region preference
 * would let this fold the two together without any other change here.
 */
export function contactPhoneMatchKey(value: string): string | null {
  const trimmed = value.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < MIN_PHONE_DIGITS) return null;
  if (trimmed.startsWith("+")) return `+${digits}`;
  if (digits.startsWith("00") && digits.length - 2 >= MIN_PHONE_DIGITS) {
    return `+${digits.slice(2)}`;
  }
  return digits;
}

/**
 * Every key a Contact can pair on — its emails and its phones, each
 * prefixed by family so a phone number that happens to read like an email's
 * local part can never pair with one. Exported on its own (not only via
 * `findDuplicateContactIds` below) so a caller with a single Contact in hand
 * — the Person Page asking "is this one a possible duplicate?" — can build
 * the same keys without materialising the whole pairing map.
 */
export function contactDuplicateKeys(contact: Pick<Contact, "emails" | "phones">): string[] {
  const keys = new Set<string>();
  for (const entry of contact.emails) {
    const key = contactEmailMatchKey(entry.value);
    if (key) keys.add(`email:${key}`);
  }
  for (const entry of contact.phones) {
    const key = contactPhoneMatchKey(entry.value);
    if (key) keys.add(`phone:${key}`);
  }
  return [...keys];
}

/**
 * Which other Contacts each Contact is a possible duplicate of — one pass
 * over the in-scope collection, keyed by `contactDuplicateKeys`. Only
 * Contacts with at least one candidate appear in the map, so a caller can
 * treat "in the map" as "show the chip" (`ContactCard.tsx`) and the map's
 * own key set as the Duplicates filter's own membership
 * (`ContactsGrid.tsx`).
 *
 * The caller decides what "Account Scope" means and passes exactly the
 * Contacts inside it (`useAccountScope.ts#deriveAddressBookScope`) — this
 * function never reaches for a scope of its own, the same split
 * `store/address-books.ts#useAddressBooks` already draws.
 *
 * Candidate ids come back sorted, so two renders of the same collection
 * produce the same order regardless of what order the Contacts arrived in.
 */
export function findDuplicateContactIds(
  contacts: readonly Contact[],
): Map<string, readonly string[]> {
  const byKey = new Map<string, string[]>();
  for (const contact of contacts) {
    for (const key of contactDuplicateKeys(contact)) {
      const bucket = byKey.get(key);
      if (bucket) bucket.push(contact.id);
      else byKey.set(key, [contact.id]);
    }
  }

  const candidates = new Map<string, Set<string>>();
  for (const ids of byKey.values()) {
    if (ids.length < 2) continue;
    for (const id of ids) {
      const others = candidates.get(id) ?? new Set<string>();
      for (const other of ids) if (other !== id) others.add(other);
      candidates.set(id, others);
    }
  }

  return new Map([...candidates].map(([id, others]) => [id, [...others].sort()]));
}

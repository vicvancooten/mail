/**
 * A minimal ULID generator (https://github.com/ulid/spec): a 48-bit
 * millisecond timestamp followed by 80 bits of randomness, both Crockford
 * Base32-encoded — 26 characters total, lexicographically sortable by
 * creation time. This is ADR-0010's Optimistic Action idempotency key:
 * client-generated, echoed by the Sync Backend, and — because it sorts the
 * way it was created — what `store/mutation-queue.ts` sorts the FIFO queue
 * by (`listQueuedMutations`).
 *
 * **Monotonic within a millisecond**: two calls landing in the same
 * millisecond (an ordinary thing for two triage actions taken back to
 * back) increment the random half instead of redrawing it, so a later call
 * always sorts after an earlier one. Without this, the FIFO order the
 * queue promises would only be probably preserved.
 *
 * Hand-rolled rather than a dependency: the whole surface is one function,
 * and pulling in a package for it would be a heavier footprint than the
 * spec itself.
 */

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const RANDOM_BYTES = 10; // 80 bits, encoding to exactly 16 base32 characters.

let lastTime = -1;
let lastRandom: Uint8Array | null = null;

export function generateUlid(now: number = Date.now()): string {
  if (now === lastTime && lastRandom) {
    incrementInPlace(lastRandom);
  } else {
    lastTime = now;
    lastRandom = randomBytes(RANDOM_BYTES);
  }
  return encodeTime(now) + encodeBase32(lastRandom);
}

/** Big-endian increment-by-one. Overflowing all 80 bits needs 2^80 calls inside one millisecond — not a real limit. */
function incrementInPlace(bytes: Uint8Array): void {
  for (let i = bytes.length - 1; i >= 0; i--) {
    if (bytes[i] === 255) {
      bytes[i] = 0;
      continue;
    }
    bytes[i] = (bytes[i] as number) + 1;
    return;
  }
}

/** Ten Crockford Base32 characters, most-significant first — 50 bits for a 48-bit timestamp. */
function encodeTime(time: number): string {
  let remaining = time;
  let encoded = "";
  for (let i = 0; i < 10; i++) {
    const digit = remaining % 32;
    encoded = CROCKFORD_BASE32[digit] + encoded;
    remaining = (remaining - digit) / 32;
  }
  return encoded;
}

/** Packs bytes into 5-bit groups; exact for any byte count that is a multiple of 5 bits (10 bytes → 16 chars, no leftover). */
function encodeBase32(bytes: Uint8Array): string {
  let bitBuffer = 0;
  let bitCount = 0;
  let encoded = "";
  for (const byte of bytes) {
    bitBuffer = (bitBuffer << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5) {
      bitCount -= 5;
      encoded += CROCKFORD_BASE32[(bitBuffer >>> bitCount) & 31];
    }
  }
  if (bitCount > 0) encoded += CROCKFORD_BASE32[(bitBuffer << (5 - bitCount)) & 31];
  return encoded;
}

function randomBytes(count: number): Uint8Array {
  const bytes = new Uint8Array(count);
  const cryptoSource = globalThis.crypto;
  if (cryptoSource?.getRandomValues) {
    cryptoSource.getRandomValues(bytes);
  } else {
    // No Web Crypto (an unusual test host): a dedup key needs uniqueness,
    // not unpredictability, so `Math.random()` is an acceptable fallback.
    for (let i = 0; i < count; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

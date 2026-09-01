/**
 * A fresh CSP script-src nonce, minted once per sandboxed document write
 * (#41, `docs/research/0005` §2's "strict per-render-nonce CSP"). Not a
 * secret in the cryptographic sense — its only job is to be unpredictable
 * enough that sanitizer-stripped sender markup can never guess it and smuggle
 * a matching `nonce` attribute onto a `<script>` tag of its own.
 */
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

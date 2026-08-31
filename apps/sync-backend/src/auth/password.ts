import { hash, verify } from "@node-rs/argon2";

// @node-rs/argon2 exposes `Algorithm` as an ambient `const enum`, which
// `isolatedModules` (tsconfig.base.json) forbids importing. Argon2id is 2 —
// and also the library's own default, so this is belt-and-suspenders.
const ARGON2ID = 2;

/**
 * argon2id, per poc-spec.md §Auth & Users. `@node-rs/argon2` ships prebuilt
 * napi-rs binaries for glibc targets, matching ADR-0009's choice of
 * `node:22-bookworm-slim` over alpine for native crypto builds.
 */
export function hashPassword(password: string): Promise<string> {
  return hash(password, { algorithm: ARGON2ID });
}

export function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  return verify(passwordHash, password);
}

# Mail Account credentials are encrypted with an instance-held key, not end-to-end

The Sync Backend must keep syncing while every User is logged out and no Client is connected — IMAP IDLE, Gatekeeper screening, Snooze wake-ups and "open the app and it's already synced" all assume unattended operation. So the key that decrypts Mail Account credentials lives with the *instance* (an env var or key file read at boot), never derived from a User's password.

## Considered Options

- **Key derived from the User's password**: rejected — genuinely stronger at rest, but the plaintext credential could only exist while that User is logged in. After a restart, every feature above would stall until each household member signed in again.
- **Envelope encryption (master key wraps per-account data keys)**: rejected — earns its keep with per-tenant key isolation or an HSM, neither of which a household instance has. A `key_version` column plus a re-encrypt loop covers rotation.
- **External secret store (Vault, SOPS, systemd credentials)**: rejected — a self-hoster tax for a threat model that already assumes host integrity.

## Consequences

- **The accepted threat model, stated plainly: the database alone is useless; the database plus the key file is not.** Encryption at rest protects dumps, snapshots and backups — not a compromised host.
- The Sync Backend refuses to boot without the key rather than starting with silently unreachable Mail Accounts.
- Each credential is sealed with an AEAD using the Mail Account id as associated data, so a ciphertext cannot be transplanted between rows, and carries a `key_version` for rotation.
- Credentials are write-only across the API: never returned, not even masked. The UI shows "password set" and a replace action.
- The stored credential is a tagged union (`password | oauth`) from the first schema. Only `password` is populated at PoC; Gmail and Outlook slot in as a new variant rather than a migration.

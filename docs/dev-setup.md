# Dev setup

Resolution of wayfinder ticket [Repo & tooling scaffold](https://github.com/vicvancooten/mail/issues/13).
The layout and commands here are what later tickets build against.

## Layout

pnpm workspaces, topologically ordered by `pnpm -r <script>`:

```
apps/
  client/         React 19 + Vite + TypeScript SPA (ADR-0002)
  sync-backend/   Fastify + TypeScript on Node 22, Postgres via Drizzle (ADR-0005)
packages/
  shared/         @mail/shared — the zod wire-contract, imported by both apps
```

`packages/shared` builds to `dist/` (via `tsc`) rather than being consumed as raw source: a
production `node dist/main.js` needs a real, resolvable `.js` file, not a `.ts` main pointed at by
package.json. `pnpm install` builds it automatically (root `postinstall`), so day-to-day this is
invisible — only Docker's multi-stage build calls it explicitly, since the runtime stage never has
`packages/shared/src` present to rebuild from.

TypeScript: every package's `tsconfig.json` extends the root `tsconfig.base.json` (strict,
`noUncheckedIndexedAccess`, `noImplicitOverride`). Lint + format is one tool, Biome
(`pnpm lint` / `pnpm lint:fix`), covering the whole repo except `.agents/`, `.claude/` (vendored
skill tooling), generated `public/` assets, and generated `db/migrations/`. Tests run on Vitest per
package (`pnpm test`); the sync-backend's health route and the client's App shell both have a smoke
test proving the wiring, not real coverage yet.

## Commands

```sh
pnpm install         # also builds @mail/shared (postinstall)
pnpm lint             # biome check, whole repo
pnpm lint:fix
pnpm typecheck        # tsc --noEmit, every package
pnpm test              # vitest run, every package
pnpm build              # tsc/vite build, every package, topological order

pnpm dev:client          # vite dev server
pnpm dev:backend          # tsx watch src/main.ts

pnpm db:generate           # drizzle-kit generate, from apps/sync-backend/src/db/schema.ts
pnpm db:migrate              # runs the same boot-path migrator the app uses (advisory-locked)
```

## Dev environment

`compose.dev.yaml` is infra only — Postgres and a local IMAP/SMTP test server (GreenMail) — not the
app itself, so the edit-save-reload loop never waits on a container rebuild:

```sh
cp .env.example .env          # once; fill in real values if PUBLIC_URL/MAIL_CREDENTIAL_KEY matter to you locally
docker compose -f compose.dev.yaml up -d
pnpm db:migrate
pnpm dev:backend               # separate terminal
pnpm dev:client                 # separate terminal
```

GreenMail (`greenmail/standalone:2.1.8`) accepts any `user@localhost` / any password over IMAP
(`localhost:3143`, no TLS) and SMTP (`localhost:3025`) — point a Mail Account's autodiscover-manual
entry at it to develop sync against real IMAP traffic without touching privateemail. **Its
CONDSTORE/QRESYNC coverage is unverified as of this scaffold** — confirm before relying on it for
[Backend language & sync-engine architecture](https://github.com/vicvancooten/mail/issues/9)'s
delta-sync tests; swap the image if it's missing something, this is a dev-only tool with no
consumers to migrate.

## Production image

`Dockerfile` builds one image (ADR-0009 / [Deployment packaging](https://github.com/vicvancooten/mail/issues/19)):
builds `@mail/client`, builds `@mail/sync-backend`, copies the client's `dist/` into the backend's
`public/`, then a `--prod` install for just the backend's dependency subgraph in a clean runtime
stage. Fastify serves `/healthz` and, when `apps/sync-backend/public` exists (only true in this
image, never in local dev), the client bundle — verified end-to-end: `docker build`, boot against
real Postgres, migration runs, `/healthz` returns 200, `index.html` serves. Runs as a non-root user
under `tini` (clean `SIGTERM` for IMAP IDLE connections). Not yet optimized for size (~580MB as of
this scaffold — `node:22-bookworm-slim` plus the full workspace `node_modules` graph); worth revisiting
once the real dependency set is closer to final.

Root `compose.yaml` is the production stack from ADR-0009 — pulls `ghcr.io/vicvancooten/mail`, never
builds; `compose.dev.yaml` is what's actually run day to day. The release pipeline
([#57](https://github.com/vicvancooten/mail/issues/57)) publishes `:edge` and `:sha-<short>` to GHCR
on every merge to `main` and exercises the pulled image end to end in CI: boot against Postgres,
migrate under the advisory lock, `/healthz`, the client bundle, and the `pg_dump` → `pull` → `up -d`
upgrade ritual once per run. See [`README.md`](../README.md#deploying) for the operator-facing
version of that ritual.

## Migrations

Drizzle ORM + drizzle-kit. `apps/sync-backend/src/db/migrate.ts` wraps `drizzle-orm`'s migrator in a
Postgres advisory lock (`pg_advisory_lock`/`_unlock`, fixed key) so concurrent boots of the `app`
container never race the schema — this is the "programmatic at boot + advisory locking" constraint
[Deployment packaging](https://github.com/vicvancooten/mail/issues/19) hands this ticket. `src/main.ts`
calls it before the server starts listening, so the app fails closed on a bad migration rather than
serving traffic against a stale schema.

The scaffold's placeholder `scaffold_probe` table is gone: User, Mail Account, Folder, Thread and
Message are all real tables now (`apps/sync-backend/src/db/schema.ts`).

## Benchmarking

`apps/corpus-bench` generates a seeded synthetic corpus at the PoC's scale bar (250k messages /
80k threads / 2 Mail Accounts, `docs/poc-scope.md`) and loads it into `compose.dev.yaml`'s Postgres
and GreenMail. It's a dev tool, not a product package — no `build` script, `pnpm -r build` skips it.
See `apps/corpus-bench/README.md` for commands; baseline search-latency numbers are in
[`docs/research/0007-250k-message-corpus-benchmark.md`](research/0007-250k-message-corpus-benchmark.md).

## Config

`apps/sync-backend/src/env.ts` — fail-closed per ADR-0009: `PUBLIC_URL` and `MAIL_CREDENTIAL_KEY`
have no default, the process exits before listening if either is missing. See `.env.example`.

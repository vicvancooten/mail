# Mail (working title)

A fast, modern, self-hosted email client. See [`CONTEXT.md`](CONTEXT.md) for the domain glossary,
`docs/adr/` for architecture decisions, and [`docs/dev-setup.md`](docs/dev-setup.md) to get running
locally.

## Deploying

The root `compose.yaml` is the production stack ([ADR-0009](docs/adr/0009-deployment-is-a-single-image-two-service-compose.md)):
it pulls versioned images from GHCR and never builds. The operator brings their own reverse proxy
and TLS.

```sh
cp .env.example .env   # fill in PUBLIC_URL, MAIL_CREDENTIAL_KEY, POSTGRES_PASSWORD
docker compose pull
docker compose up -d
```

Every merge to `main` publishes `ghcr.io/vicvancooten/mail:edge` plus an immutable
`ghcr.io/vicvancooten/mail:sha-<short>`; pushing a `vX.Y.Z` tag additionally publishes `:X.Y.Z` and
`:X.Y`. `MAIL_VERSION` in `.env` selects which tag `compose.yaml` pulls (`edge` by default).

### Upgrading

Migrations are forward-only and run in the app's own boot path behind an advisory lock — there is no
separate migration step, but there is also no going back across a schema change. The ritual:

```sh
docker compose exec postgres pg_dump -U "${POSTGRES_USER:-mail}" "${POSTGRES_DB:-mail}" > backup-$(date +%F).sql
docker compose pull
docker compose up -d
```

Watch `docker compose logs -f app` until it reports listening, then confirm
`curl $PUBLIC_URL/healthz` returns `{"status":"ok",...}`.

### Rolling back

Pin `MAIL_VERSION` in `.env` to the immutable `sha-<short>` tag of the last-known-good build (visible
in the GHCR package's tag list, or the CI run for that merge), then re-run `docker compose up -d`.

If a migration ran since that build, code alone can't roll back — restore `backup-<date>.sql` into a
fresh `postgres` volume first, then repin.

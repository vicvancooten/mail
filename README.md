# Mail (working title)

A fast, modern, self-hosted email client.

## Getting started

**[→ Installation guide](docs/installation.md)** — deploy your own instance with Docker Compose:
prerequisites, first-run setup, exposing it publicly behind a reverse proxy, backups, and upgrades.

```sh
cp .env.example .env   # fill in PUBLIC_URL, MAIL_CREDENTIAL_KEY, POSTGRES_PASSWORD
docker compose pull
docker compose up -d
```

The root `compose.yaml` is the production stack ([ADR-0009](docs/adr/0009-deployment-is-a-single-image-two-service-compose.md)):
it pulls versioned images from GHCR and never builds. The operator brings their own reverse proxy
and TLS — see the [installation guide](docs/installation.md#exposing-it-publicly) for a copy-pasteable
example, upgrade/rollback rituals, and backups.

Contributing instead? See [`CONTEXT.md`](CONTEXT.md) for the domain glossary, `docs/adr/` for
architecture decisions, and [`docs/dev-setup.md`](docs/dev-setup.md) to get a dev environment
running locally.

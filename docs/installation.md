# Installation

A self-hosted guide for running a Mail instance: one Docker Compose stack, two containers (`app`,
`postgres`), no build step. See [ADR-0009](adr/0009-deployment-is-a-single-image-two-service-compose.md)
for why the deployment is shaped this way. For local development instead of running a deployed
instance, see [`dev-setup.md`](dev-setup.md).

## Prerequisites

- Docker Engine with the Compose plugin (`docker compose version` — v2 syntax, not `docker-compose`).
- A domain name pointed at the host, **if** you want Mail reachable from outside `localhost` — needed
  for passkeys and Web Push to work correctly (see [Public URL](#public-url) below). Not required to
  try Mail out locally.
- A reverse proxy for TLS if you're going public. Mail doesn't bundle one — see
  [Exposing it publicly](#exposing-it-publicly).

## Quick start (try it locally)

Mail's own source is never part of the running stack — `compose.yaml` only pulls published images
(see [ADR-0009](adr/0009-deployment-is-a-single-image-two-service-compose.md)) — so you don't need a
clone of this repo to run it. Two files are enough: `compose.yaml` and `.env`.

```sh
mkdir mail && cd mail
curl -fsSLO https://raw.githubusercontent.com/vicvancooten/mail/main/compose.yaml
curl -fsSLO https://raw.githubusercontent.com/vicvancooten/mail/main/.env.example
cp .env.example .env
```

Open `.env` and set:

```sh
PUBLIC_URL=http://localhost:3000
MAIL_CREDENTIAL_KEY=$(openssl rand -base64 32)   # generate a real one, don't leave the placeholder
POSTGRES_PASSWORD=<pick-something>
```

Then:

```sh
docker compose pull
docker compose up -d
docker compose logs -f app
```

(If you do have a clone of this repo already — e.g. for development — `compose.yaml` and
`.env.example` are at its root, so skip the two `curl`s and start from `cp .env.example .env`.)

Wait for the log line that says `listening` — that same startup log also prints the one-time claim
link (see [First run: claiming the instance](#first-run-claiming-the-instance)). Open
`http://localhost:3000` and follow it.

## Public URL

`PUBLIC_URL` is not cosmetic — it's the source of truth for the WebAuthn Relying Party ID, cookie
scope, and Web Push, and it is **not** derived from proxy headers, so a misconfigured proxy can't
silently register passkeys against the wrong origin. Set it to the exact origin browsers will use
(`https://mail.example.com`, no trailing slash). Changing it later re-enrolls every passkey — treat
it as fixed once you've claimed the instance and added an account.

## Configuration reference

Everything is env vars — copy `.env.example` to `.env` and fill in. Required (the app refuses to
boot without these):

| Variable | What it is |
|---|---|
| `PUBLIC_URL` | The origin Mail is reached at, e.g. `https://mail.example.com`. See [above](#public-url). |
| `MAIL_CREDENTIAL_KEY` | `openssl rand -base64 32`. Encrypts stored IMAP/SMTP credentials at rest. Losing it costs re-authenticating every Mail Account, not mail loss — it isn't the message store. |
| `POSTGRES_PASSWORD` | Postgres password; also read by the `postgres` service itself. |

Optional, with sane defaults:

| Variable | Default | What it is |
|---|---|---|
| `MAIL_BIND` | `127.0.0.1:3000` | host:port the `app` container's port is published on. Loopback-only by default — set this to `0.0.0.0:3000` (or a LAN address) only if your reverse proxy runs on a different host. |
| `MAIL_VERSION` | `edge` | Which GHCR image tag `compose.yaml` pulls. See [Upgrading](#upgrading). |
| `POSTGRES_USER` / `POSTGRES_DB` | `mail` | Postgres user/database name. |
| `ATTACHMENT_BUDGET_BYTES` | `26214400` (25MB) | Per-instance attachment size budget, encoded bytes. |
| `MAIL_VAPID_PUBLIC_KEY` / `MAIL_VAPID_PRIVATE_KEY` | unset | Web Push keypair. Unset simply means no push notifications — everything else works. See [Enabling Web Push](#enabling-web-push-optional). |
| `MAIL_VAPID_CONTACT` | `mailto:admin@localhost` | Contact URI Web Push's protocol requires alongside the VAPID keypair — set it to a real `mailto:` if you enable Web Push. |

## First run: claiming the instance

A fresh instance has no users. On boot it prints a one-time claim link to the `app` container's
logs, valid for 24 hours:

```sh
docker compose logs app | grep "Claim this instance"
```

Open that link, set the Owner's username and password. There's no sign-up form and no second
Owner — this is a single-operator instance, and the link is invalidated (a fresh one printed) on
every boot until it's used.

After claiming, **adding a Mail Account is a separate step**, done from within the app: enter the
mail address, and Mail tries autodiscover (SRV records, then Mozilla's ISPDB) before falling back to
manual IMAP/SMTP host, port, and TLS entry.

## Exposing it publicly

Mail binds loopback-only (`MAIL_BIND=127.0.0.1:3000`) and expects you to put a TLS-terminating
reverse proxy in front of it — no bundled proxy, no certificate management, so a proxy you already
run (or one running on the same host) can front it without a second moving part. A minimal Caddy
example (Caddy renews TLS on its own):

```
mail.example.com {
	reverse_proxy 127.0.0.1:3000
}
```

Whatever proxy you use, forward `Host`, `X-Forwarded-For`, and `X-Forwarded-Proto` — the app trusts
those to know it's being reached over `https://` even though the proxy-to-app hop is plain HTTP on
localhost. `PUBLIC_URL` must match what's in the browser's address bar exactly.

If the proxy runs on a different host than `app`, set `MAIL_BIND` to an address that host can reach
(e.g. `MAIL_BIND=0.0.0.0:3000`, or a specific LAN address) — traffic between the two hosts is then
plaintext HTTP, so keep that hop on a network you trust.

## Enabling Web Push (optional)

Push notifications need a VAPID keypair, generated once with the operator CLI baked into the image:

```sh
docker compose run --rm app mail generate-vapid-keys
```

Copy the two printed lines into `.env` as `MAIL_VAPID_PUBLIC_KEY` / `MAIL_VAPID_PRIVATE_KEY`, then
`docker compose up -d` to pick them up. The pair is generated once and reused across restarts —
regenerating it invalidates every browser's existing push subscription.

## Enabling Gmail and Outlook sign-in (optional)

Google and Microsoft accounts are added by signing in with the Provider (CONTEXT.md), which needs a
Provider Registration — an OAuth app the Owner registers with that Provider, per instance
([ADR-0021](adr/0021-provider-registration-is-per-instance-and-owner-entered.md)). There's no shared
client ID baked into Mail itself: each instance's Owner registers their own app with Google or
Microsoft, then pastes the client ID and secret into the Instance page (Owner only) — no restart, no
`.env` entry, no env var (the form is the only source; the [configuration reference](#configuration-reference)
above doesn't grow one). The Instance page shows the exact redirect URI to copy and a short version
of the steps below beside each Provider's fields; this section is the full walkthrough it links to.

Both providers derive the redirect URI the same way, from `PUBLIC_URL` (the same
[single source of truth](#public-url) cookies, WebAuthn, and Web Push already use):

```
{PUBLIC_URL}/auth/oauth/{google|microsoft}/callback
```

e.g. `https://mail.example.com/auth/oauth/google/callback`. Both providers reject a redirect URI
that's plain `http://` on a non-loopback host — the Instance page warns about this if your `PUBLIC_URL`
is affected — so this only works once you're [exposed over https](#exposing-it-publicly), or when
trying it against `http://localhost:3000`.

### Google

1. In the [Google Cloud console](https://console.cloud.google.com/), create a new project (or pick an
   existing one you're happy to dedicate to this).
2. Under **APIs & Services → OAuth consent screen**, configure the consent screen (External user type
   is fine for a personal instance — you don't need to publish it anywhere).
3. Under **APIs & Services → Credentials**, create an **OAuth client ID** of type **Web application**,
   and add the redirect URI from above under **Authorized redirect URIs**.
4. **Set the app to In Production**, not Testing. This is the one step it's easy to skip and painful
   to miss: an app left in Testing status issues refresh tokens that expire after **seven days**,
   which lands every Gmail Mail Account in Needs Reauth weekly for no visible reason
   ([ADR-0021](adr/0021-provider-registration-is-per-instance-and-owner-entered.md)). An unverified
   app in Production is fine for this use — Google shows a one-time "unverified app" warning on the
   consent screen the first time you sign in, nothing more; formal verification is a CASA audit
   you don't need for a household instance.
   - **Google Workspace Owner?** Register the app as **Internal** instead of External, and skip this
     step entirely — Internal apps aren't subject to the Testing/Production distinction or the
     seven-day refresh-token expiry.
5. Copy the **Client ID** and **Client secret** from the credentials page and paste them into the
   Instance page's Google Registration form.

### Microsoft

1. In the [Microsoft Entra admin center](https://entra.microsoft.com/), go to **App registrations →
   New registration**.
2. Under **Supported account types**, choose **Accounts in any organizational directory and personal
   Microsoft accounts** — this is what lets both Outlook.com addresses and work/school (Microsoft 365)
   addresses sign in through the same Registration.
3. Under **Redirect URI**, add a **Web** platform entry with the redirect URI from above.
4. Under **Certificates & secrets**, create a new **client secret** — note it down immediately, it's
   only shown once.
5. Under **API permissions**, add the delegated Microsoft Graph/IMAP permissions for mail access
   (`IMAP.AccessAsUser.All`, `SMTP.Send`) plus `offline_access` (without it, Microsoft won't issue a
   refresh token at all, so sign-in would appear to work once and then fail on every subsequent sync).
6. Copy the **Application (client) ID** from the app's Overview page and the client secret's **value**
   (not its ID) from step 4, and paste them into the Instance page's Microsoft Registration form.

**A caveat outside the Owner's control:** an M365 (work/school) tenant's admin may have IMAP disabled
tenant-wide, or may require admin consent before anyone in that tenant can use this Registration at
all. Neither is something Mail or the Registration can detect or fix — it surfaces to that user as a
failed sign-in with a plain error message, and the fix is asking their tenant admin, not re-registering
anything here ([ADR-0021](adr/0021-provider-registration-is-per-instance-and-owner-entered.md)).

### After registering

Back on the Instance page, the Provider's status moves from **Not registered** to **Registered,
untested** — untested because neither Provider can be validated without a User actually consenting.
"Working" only shows up once someone signs in and Mail can see a real Grant refreshing successfully.

## Upgrading

Every merge to `main` publishes `ghcr.io/vicvancooten/mail:edge` plus an immutable
`ghcr.io/vicvancooten/mail:sha-<short>`; a `vX.Y.Z` tag push additionally publishes `:X.Y.Z` and
`:X.Y`. `MAIL_VERSION` in `.env` selects which tag `compose.yaml` pulls (`edge` by default).

Migrations are forward-only and run in the app's own boot path behind an advisory lock — there's no
separate migration step, but no going back across a schema change either. The ritual:

```sh
docker compose exec postgres pg_dump -U "${POSTGRES_USER:-mail}" "${POSTGRES_DB:-mail}" > backup-$(date +%F).sql
docker compose pull
docker compose up -d
docker compose logs -f app        # watch until it reports listening
curl "$PUBLIC_URL/healthz"        # expect {"status":"ok",...}
```

## Rolling back

Pin `MAIL_VERSION` in `.env` to the immutable `sha-<short>` tag of the last-known-good build (visible
in the GHCR package's tag list, or the CI run for that merge), then `docker compose up -d`.

If a migration ran since that build, code alone can't roll back — restore `backup-<date>.sql` into a
fresh `postgres` volume first, then repin the version.

## Backups

The complete backup surface is `pgdata` (the named Postgres volume) plus `.env` — the `app`
container itself holds no state and is fully disposable. Back up both:

```sh
docker compose exec postgres pg_dump -U "${POSTGRES_USER:-mail}" "${POSTGRES_DB:-mail}" > backup-$(date +%F).sql
cp .env .env.backup-$(date +%F)
```

`.env` contains `MAIL_CREDENTIAL_KEY` — losing it, even with an intact database dump, means every
Mail Account has to be re-authenticated (the encrypted IMAP/SMTP credentials in the dump become
unusable). Store it like the secret it is.

## Account recovery

There's no self-service "forgot password" flow yet — the operator CLI is the recovery path, run
against the live container:

```sh
docker compose exec app mail reset-owner-password <new-password>   # also revokes all sessions
docker compose exec app mail disable-totp                          # lost your authenticator
```

## Troubleshooting

- **`app` won't boot, logs an env validation error** — `PUBLIC_URL` or `MAIL_CREDENTIAL_KEY` is
  missing or malformed; both are fail-closed by design. Check `.env` against the
  [reference](#configuration-reference) above.
- **`docker compose up -d` hangs on `postgres`** — `app` waits on Postgres's healthcheck
  (`pg_isready`) before starting; give it a few seconds on first boot.
- **Passkeys or Web Push behave oddly after a domain change** — expected. Both are bound to
  `PUBLIC_URL`'s exact origin; changing it re-enrolls passkeys and drops existing push subscriptions.
- **`curl $PUBLIC_URL/healthz` doesn't return `{"status":"ok",...}`** — check `docker compose logs
  app` first; a healthy boot logs a `listening` line before this ever succeeds.

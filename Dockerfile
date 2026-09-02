# Single-image build: the Client bundle and the Sync Backend ship together
# so a fresh load can never see a mismatched pair (ADR-0009).

FROM node:22-bookworm-slim AS base
RUN corepack enable
ENV CI=true
WORKDIR /repo

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @mail/client build
RUN pnpm --filter @mail/sync-backend build
RUN mkdir -p apps/sync-backend/public && cp -r apps/client/dist/. apps/sync-backend/public/

FROM base AS runtime
ENV NODE_ENV=production
# tini as PID 1 so SIGTERM reaches Node and IMAP IDLE connections close
# cleanly instead of being severed mid-write (ADR-0009).
RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/client/package.json apps/client/package.json
COPY apps/sync-backend/package.json apps/sync-backend/package.json
COPY packages/shared/package.json packages/shared/package.json
# --ignore-scripts: skip the root postinstall (rebuilds @mail/shared from
# source, which isn't in this stage — the build stage already produced dist).
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter @mail/sync-backend...

COPY --from=build /repo/packages/shared/dist packages/shared/dist
COPY --from=build /repo/apps/sync-backend/dist apps/sync-backend/dist
COPY --from=build /repo/apps/sync-backend/public apps/sync-backend/public

# The operator CLI (password-reset escape hatch, ADR-0009 deployment): a
# `mail` command on PATH, `docker compose exec app mail reset-owner-password
# <password>`, reusing the same argon2id hasher and DB connection as the app.
RUN printf '#!/bin/sh\nexec node /repo/apps/sync-backend/dist/cli.js "$@"\n' > /usr/local/bin/mail \
  && chmod +x /usr/local/bin/mail

# node:22-bookworm-slim already has a system "mail" group/user; ours is the
# app's own unprivileged runtime identity, kept distinctly named.
RUN groupadd -r mailapp && useradd -r -g mailapp mailapp && chown -R mailapp:mailapp /repo
USER mailapp

WORKDIR /repo/apps/sync-backend
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]

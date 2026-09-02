#!/usr/bin/env bash
# Blocks until compose.dev.yaml's postgres service accepts connections.
# Used by `pnpm dev:infra:up` — there's no healthcheck on the service, so we
# poll `pg_isready` inside the container instead of guessing a sleep.
set -euo pipefail

tries=30
until docker compose -f compose.dev.yaml exec -T postgres pg_isready -U "${POSTGRES_USER:-mail}" >/dev/null 2>&1; do
  tries=$((tries - 1))
  if [ "$tries" -le 0 ]; then
    echo "postgres did not become ready in time" >&2
    exit 1
  fi
  sleep 1
done

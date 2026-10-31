#!/usr/bin/env bash
# CI pipeline of the backend (P2.2): install, start the local services, run `bun run check`.
# Exits non-zero on the first failure and names the step that failed; any CI system can call it (no hosted CI yet).
# Run it from anywhere: `scripts/ci.sh`.

# Environment:
#   FRONTEND_DIR       the frontend checkout (default ../frontend-admin): `contract:check` reads its TypeScript.
#   CI_SKIP_SERVICES=1 do not touch Docker: Postgres and Redis are provided elsewhere (set DATABASE_URL_TEST,
#                      REDIS_QUEUE_URL, REDIS_CACHE_URL, S3_ENDPOINT to point at them).
#   CI_HEALTH_WAIT_SECONDS  how long to wait for running services to become healthy (default 60).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

current="starting"
trap 'status=$?; if [ "$status" -ne 0 ]; then printf "\nCI FAILED during: %s (exit %s)\n" "$current" "$status" >&2; fi' EXIT

step() {
  current="$1"
  printf '\n==> %s\n' "$1"
}

step "Check the inputs: frontend checkout and the reference symlink"
frontend="${FRONTEND_DIR:-../frontend-admin}"
if [ ! -d "$frontend/src" ]; then
  echo "The frontend checkout was not found at '$frontend' (set FRONTEND_DIR). contract:check needs it." >&2
  exit 1
fi
if [ ! -d reference/gsm-map ]; then
  echo "reference/ must point at the frontend's reference folder (ln -s ../frontend-admin/reference reference)." >&2
  exit 1
fi

step "bun install --frozen-lockfile"
bun install --frozen-lockfile

if [ "${CI_SKIP_SERVICES:-}" = "1" ]; then
  step "Skip the local services (CI_SKIP_SERVICES=1)"
else
  step "Start the local services (Postgres, queue Redis, cache Redis, MinIO) if they are not running"
  if ! command -v docker >/dev/null 2>&1; then
    echo "Docker is not installed. Install it, or provide the services yourself and set CI_SKIP_SERVICES=1." >&2
    exit 1
  fi
  # Services that already run are left alone: `docker compose up` from another checkout (a git worktree) would see a
  # different bind-mount path and recreate the container under whoever is using it. Only a missing service is started.
  required="postgres redis-queue redis-cache minio"
  running="$(docker compose ps --status running --services 2>/dev/null || true)"
  missing=""
  for service in $required; do
    grep -qx "$service" <<<"$running" || missing="$missing $service"
  done
  if [ -n "$missing" ]; then
    echo "Starting:$missing"
    # --wait returns once every service that has a healthcheck is healthy; MinIO has none and counts as running.
    docker compose up -d --wait $missing
    # One-shot bucket creation after MinIO starts (exits when done; safe to repeat).
    case " $missing " in *" minio "*) docker compose up -d minio-init ;; esac
  else
    echo "Postgres, both Redis instances and MinIO are already running."
  fi
  # A running container may still be starting: wait (CI_HEALTH_WAIT_SECONDS, default 60) until the ones with a
  # healthcheck are healthy.
  wait_seconds="${CI_HEALTH_WAIT_SECONDS:-60}"
  for service in postgres redis-queue redis-cache; do
    container="$(docker compose ps -q "$service")"
    for _ in $(seq 1 $((wait_seconds / 2 + 1))); do
      [ "$(docker inspect --format '{{.State.Health.Status}}' "$container")" = "healthy" ] && break
      sleep 2
    done
    if [ "$(docker inspect --format '{{.State.Health.Status}}' "$container")" != "healthy" ]; then
      echo "$service is not healthy after ${wait_seconds} s (docker compose logs $service)." >&2
      exit 1
    fi
  done
fi

step "bun run check (typecheck, lint, route manifest, contract docs, OpenAPI documents, tests)"
bun run check

printf '\nCI passed.\n'

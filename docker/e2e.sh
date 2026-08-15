#!/usr/bin/env bash
# One entry point for the Dockerised E2E flow: boot the containers once, then exec each run into them.
#
# Everything a run selects is a Mocha flag forwarded to `out/e2e/runE2E.js` as an argument, so
# narrowing the matrix never touches the container's configuration and never causes a recreation
# (compose recreates on any config change, so a sweep used to pay a boot per driver):
#
#   docker/e2e.sh check                  every case × every driver
#   docker/e2e.sh check --grep @codex    one driver, every case
#
# Mode is the one thing that legitimately differs at the container level: `record` mounts the user's
# credentials, `check` deliberately mounts none, so switching between them still recreates.
set -euo pipefail

cd "$(dirname "$0")/.."

mode="${1:-check}"
if [ "$mode" != "check" ] && [ "$mode" != "record" ]; then
  echo "usage: docker/e2e.sh <check|record> [mocha args, e.g. --grep @codex]" >&2
  exit 2
fi
shift || true

files=(-f docker/docker-compose.yml -f docker/docker-compose.mockserver.yml)
env_args=()
# Only the recording path gets credentials, so a check run cannot reach a real provider even by
# accident — that is the property that makes `check` safe to run anywhere.
if [ "$mode" = "record" ]; then
  bash docker/prepare-e2e.sh
  files+=(-f docker/docker-compose.e2e.yml)
  env_args+=(-e ANTHROPIC_API_KEY)
  env_args+=(-e KIRO_API_KEY)
fi

docker compose "${files[@]}" up -d --wait
# `${a[@]+"${a[@]}"}` because an empty array is an unbound variable under `set -u` on bash 3.2 (macOS).
exec docker compose "${files[@]}" exec -T ${env_args[@]+"${env_args[@]}"} tests pnpm "e2e:$mode" "$@"

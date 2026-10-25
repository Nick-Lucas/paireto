#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

mode="${1:-replay}"
if [ "$mode" != "record" ] && [ "$mode" != "replay" ] && [ "$mode" != "render" ]; then
  echo "usage: docker/demo.sh <record|replay|render>" >&2
  exit 2
fi

demo_user="${PAIRETO_DEMO_USER:-sam}"
files=(-f docker/docker-compose.yml -f docker/docker-compose.mockserver.yml)
env_args=()
if [ "$mode" = "record" ]; then
  bash docker/prepare-e2e.sh
  files+=(-f docker/docker-compose.e2e.yml)
  env_args+=(-e ANTHROPIC_API_KEY)
fi
if [ -n "${DEBUG:-}" ]; then
  env_args+=(-e DEBUG)
fi
if [ -n "${PAIRETO_SHIM_DUMP:-}" ]; then
  env_args+=(-e "PAIRETO_SHIM_DUMP=/workspace/$PAIRETO_SHIM_DUMP")
fi

compose() {
  docker compose "${files[@]}" "$@"
}

compose up -d --wait --build

if [ "$mode" != "render" ]; then
  compose exec -T tests bash -c "
    set -e
    pnpm install --frozen-lockfile >/dev/null
    id -u '$demo_user' >/dev/null 2>&1 || useradd --create-home --uid 1001 --shell /bin/bash '$demo_user'
    mkdir -p /private/tmp && chmod 1777 /private/tmp
    rm -rf /tmp/pai-demo /private/tmp/acme-checkout /private/tmp/pai-demo-claude-home
    pnpm run package >/dev/null
    pnpm run compile-tests >/dev/null
  "
  compose exec -T -u "$demo_user" ${env_args[@]+"${env_args[@]}"} tests node out/demo/record.js "$mode"
else
  compose exec -T tests pnpm run compile-tests >/dev/null
fi

compose exec -T tests node out/demo/render.js

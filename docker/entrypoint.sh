#!/usr/bin/env bash

set -euo pipefail

# The repo is bind-mounted, so /workspace/node_modules would otherwise be the HOST's macOS install —
# unusable here because esbuild/oxlint/oxfmt ship per-platform native binaries. A named volume shadows
# it (see docker-compose.yml); we populate it once (cached across runs) when it's empty.
if [ ! -d node_modules/.pnpm ]; then
  echo "paireto-docker: installing dependencies (Linux) ..."
  pnpm install --frozen-lockfile
fi

# Headless display for VS Code/Electron. We start Xvfb ourselves rather than use `xvfb-run`, whose
# USR1 readiness handshake hangs in this container (the wrapped command never launches). Xvfb itself
# starts fine; we just poll for its socket. DISPLAY is an image ENV so exec'd commands see it too.
# -ac disables X access control so a `docker compose exec`-ed client (a different session, with no
# XAUTHORITY cookie) can still connect — without it the exec'd Electron dies with "Authorization
# required" and SIGSEGVs.
Xvfb "$DISPLAY" -ac -screen 0 1280x1024x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
for _ in $(seq 1 50); do
  [ -e /tmp/.X11-unix/X99 ] && break
  sleep 0.1
done

# Readiness marker for the compose healthcheck — `up --wait` blocks on this, so a test exec never
# races the first-boot install/display setup above.
touch /tmp/paireto-ready

exec "$@"

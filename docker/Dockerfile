# Headless test image for Paireto — runs the VS Code unit suite (`pnpm test`) and the E2E suite
# (`pnpm test:e2e`) inside a Linux container with a virtual X display (xvfb), so no VS Code window
# ever pops up on the macOS host. See docker/README.md.
#
# The repo is bind-mounted at /workspace (see docker-compose.yml) — nothing is COPYed in except the
# entrypoint. node_modules and .vscode-test are container-local named volumes, since the host's macOS
# native binaries (esbuild/oxlint/oxfmt) and macOS VS Code download can't be reused on Linux.

FROM node:24-bookworm

# --- System deps: virtual display, TUI tooling, and the Electron/Chromium runtime libraries VS Code
#     needs to launch (test-electron downloads a Linux VS Code build that links against these). ---
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb \
      xauth \
      dbus-x11 \
      tmux \
      git \
      ca-certificates \
      openssl \
      libnss3 \
      libnspr4 \
      libatk1.0-0 \
      libatk-bridge2.0-0 \
      libcups2 \
      libdrm2 \
      libgtk-3-0 \
      libgbm1 \
      libasound2 \
      libxkbcommon0 \
      libxcomposite1 \
      libxdamage1 \
      libxfixes3 \
      libxrandr2 \
      libpango-1.0-0 \
      libcairo2 \
      libatspi2.0-0 \
      libxshmfence1 \
      libx11-xcb1 \
    && rm -rf /var/lib/apt/lists/*

# Keep the container on the version declared in package.json and used by CI.
RUN npm install -g pnpm@11.21.0

# --- Harness CLIs for the E2E suite (full e2e support baked in). ---
# claude:   @anthropic-ai/claude-code  -> `claude`
# codex:    @openai/codex              -> `codex`   (TODO: if a future release changes its distribution
#                                                    away from npm, swap this for its documented installer)
# opencode: opencode-ai                -> `opencode`
RUN npm install -g \
      @anthropic-ai/claude-code \
      @openai/codex \
      opencode-ai

# OpenCode installs the plugin SDK (@opencode-ai/plugin) from npm at runtime, which credential-free
# `check` runs cannot do. Without it our plugin advertises paireto_submit_plan with no `plan`
# parameter and the model can never submit a plan. Pre-staging the SDK here lets mock-mode runs
# resolve it offline. See OpenCodeDriver.stagePluginSdk.
ENV PAIRETO_OPENCODE_SDK=/opt/opencode-sdk
RUN mkdir -p "$PAIRETO_OPENCODE_SDK" \
    && cd "$PAIRETO_OPENCODE_SDK" \
    && npm init -y > /dev/null \
    && npm install @opencode-ai/plugin

WORKDIR /workspace

# The headless display the entrypoint's Xvfb serves. Set as an image ENV (not just an entrypoint
# export) so `docker compose exec`-ed commands — which don't pass through the entrypoint — inherit it.
ENV DISPLAY=:99

COPY entrypoint.sh /usr/local/bin/paireto-entrypoint.sh
RUN chmod +x /usr/local/bin/paireto-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/paireto-entrypoint.sh"]

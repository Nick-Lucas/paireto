# Headless test image for Paireto — runs the VS Code unit suite (`pnpm test`) and the E2E suite
# (`pnpm test:e2e`) inside a Linux container with a virtual X display (xvfb), so no VS Code window
# ever pops up on the macOS host. See docker/README.md.
#
# The repo is bind-mounted at /workspace (see docker-compose.yml) — nothing is COPYed in except the
# entrypoint. node_modules and .vscode-test are container-local named volumes, since the host's macOS
# native binaries (esbuild/oxlint/oxfmt) and macOS VS Code download can't be reused on Linux.

FROM node:26-bookworm

# --- System deps: virtual display, TUI tooling, and the Electron/Chromium runtime libraries VS Code
#     needs to launch (test-electron downloads a Linux VS Code build that links against these). ---
# The Debian CDN rejects some encoded package versions over plain HTTP.
RUN sed -i 's|URIs: http://|URIs: https://|' /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends \
      xvfb \
      xauth \
      dbus-x11 \
      tmux \
      ripgrep \
      git \
      ca-certificates \
      openssl \
      curl \
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
# claude:   @anthropic-ai/claude-code       -> `claude`
# codex:    @openai/codex                   -> `codex`   (TODO: if a future release changes its
#                                                         distribution away from npm, swap this for its
#                                                         documented installer)
# opencode: opencode-ai                     -> `opencode`
# pi:       @earendil-works/pi-coding-agent -> `pi`      (--ignore-scripts is what pi's own npm install
#                                                         instructions use)
ARG CLAUDE_CODE_VERSION=2.1.288
ARG CODEX_VERSION=0.160.0
ARG OPENCODE_VERSION=1.18.34
ARG PI_VERSION=0.85.1
ARG KIRO_VERSION=2.27.0
ARG KIRO_SHA256_ARM64=fd55b9b3e626262a36bbaa7857e666e0f15bb06d906a22a50cae7338ffeb64e1
ARG KIRO_SHA256_AMD64=0c08099c718ade0cb0d8648e18706d9002eadb8ca0158049c0313433b8a4eb51
ARG TARGETARCH

RUN npm install -g \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@openai/codex@${CODEX_VERSION}" \
      "opencode-ai@${OPENCODE_VERSION}" \
    && npm install -g --ignore-scripts "@earendil-works/pi-coding-agent@${PI_VERSION}" \
    && pi --version

# Every kiro-cli* binary is linked, not just the entry point: `kiro-cli chat` re-execs its sibling
# `kiro-cli-chat` BY NAME through PATH (2.18.1 split chat and term out of the single binary), so
# linking the entry point alone leaves every chat session dying with "os error 2" before it starts.
RUN case "$TARGETARCH" in \
      arm64) kiro_zip=kirocli-aarch64-linux-musl.zip; kiro_sha256="$KIRO_SHA256_ARM64" ;; \
      amd64) kiro_zip=kirocli-x86_64-linux.zip; kiro_sha256="$KIRO_SHA256_AMD64" ;; \
      *) echo "no pinned Kiro archive for $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && kiro_tmp="$(mktemp -d)" \
    && curl -fsSL -o "$kiro_tmp/$kiro_zip" "https://prod.download.cli.kiro.dev/stable/${KIRO_VERSION}/$kiro_zip" \
    && echo "$kiro_sha256  $kiro_tmp/$kiro_zip" | sha256sum -c - \
    && unzip -q "$kiro_tmp/$kiro_zip" -d "$kiro_tmp" \
    && KIRO_CLI_SKIP_SETUP=1 "$kiro_tmp/kirocli/install.sh" \
    && rm -rf "$kiro_tmp" \
    && test -x /root/.local/bin/kiro-cli \
    && for bin in /root/.local/bin/kiro-cli*; do \
         ln -sf "$bin" "/usr/local/bin/$(basename "$bin")"; \
       done \
    && kiro-cli --version \
    && command -v kiro-cli-chat >/dev/null

# OpenCode installs the plugin SDK (@opencode-ai/plugin) from npm at runtime, which credential-free
# `check` runs cannot do. Without it our plugin advertises paireto_submit_plan with no `plan`
# parameter and the model can never submit a plan. Pre-staging the SDK here lets mock-mode runs
# resolve it offline. See OpenCodeDriver.stagePluginSdk.
ENV PAIRETO_OPENCODE_SDK=/opt/opencode-sdk
RUN mkdir -p "$PAIRETO_OPENCODE_SDK" \
    && cd "$PAIRETO_OPENCODE_SDK" \
    && npm init -y > /dev/null \
    && npm install "@opencode-ai/plugin@${OPENCODE_VERSION}"

WORKDIR /workspace

# The headless display the entrypoint's Xvfb serves. Set as an image ENV (not just an entrypoint
# export) so `docker compose exec`-ed commands — which don't pass through the entrypoint — inherit it.
ENV DISPLAY=:99

RUN echo '--sort=path' > /etc/ripgreprc
ENV RIPGREP_CONFIG_PATH=/etc/ripgreprc

COPY entrypoint.sh /usr/local/bin/paireto-entrypoint.sh
RUN chmod +x /usr/local/bin/paireto-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/paireto-entrypoint.sh"]

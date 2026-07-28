# Headless tests in Docker

Both Paireto test suites launch a real VS Code (Electron) window via `@vscode/test-electron`. On macOS
that window pops up and steals focus on every run. Running the suites inside a **Linux container with a
virtual X display (`xvfb`)** makes them fully headless — no window ever reaches the macOS host.

The container is **persistent**: you boot it once, and it keeps your code + dependencies mounted from
the host while you send test commands into it (streaming their output back). No rebuild per run.

## Prerequisites

- Docker Desktop (or any Docker engine + `docker compose`).
- For the **claude** E2E driver: nothing to do manually — `test:e2e:docker` extracts your Claude
  credential from the macOS keychain automatically (or set `ANTHROPIC_API_KEY` and it wins).

## Commands

```sh
pnpm docker:build          # build the image once (Node deps' Linux runtime + the 3 harness CLIs)

pnpm test:docker           # boots the container (if needed) and runs the unit suite in it
pnpm docker:shell          # a bash shell inside the running container
pnpm docker:down           # stop the persistent container

# E2E — pick a driver (there is no default). Credentials are staged/mounted automatically (see below).
PAIRETO_E2E_DRIVER=claudecode pnpm test:e2e:docker
PAIRETO_E2E_DRIVER=codex      pnpm test:e2e:docker
PAIRETO_E2E_DRIVER=opencode   pnpm test:e2e:docker

# Provider recording / strict credential-free replay — also runs in the tests service.
PAIRETO_E2E_DRIVER=claudecode pnpm e2e:record:docker
PAIRETO_E2E_DRIVER=claudecode pnpm e2e:check:docker
```

`test:docker` / `test:e2e:docker` each do `docker compose up -d --wait` (a no-op once booted) and then
`docker compose exec` the suite — so the first run pays the boot cost and later runs are just the exec.
The first boot does a Linux `pnpm install` into a named volume (host macOS `node_modules` can't be
reused — esbuild/oxlint/oxfmt are per-platform native binaries), cached across runs, as is the Linux
VS Code download (`.vscode-test`). The compose healthcheck makes `up --wait` block until that's done,
so a test exec never races the install.

## How it works

- `Dockerfile` — `node:22-bookworm` + Electron/Chromium runtime libs + `xvfb`, `tmux`, `git`, OpenSSL,
  and the `claude` / `codex` / `opencode` CLIs. OpenSSL creates the long-lived, machine-local proxy
  identity under the ignored bind-mounted cert directory; no test private keys live in the image or
  Git. pnpm is pinned to the host's version. `DISPLAY=:99` is an image ENV so exec'd commands (which
  skip the entrypoint) inherit it.
- `entrypoint.sh` — one-time boot: ensures the Linux dependency install, starts Xvfb directly (not
  `xvfb-run`, which hangs in-container), marks the container ready, then runs `sleep infinity`.
- `docker-compose.yml` — the persistent `tests` service: bind-mounts the repo at `/workspace`, shadows
  `node_modules` + `.vscode-test` with container-local named volumes, sets `shm_size: 2gb` (Chromium
  needs more than Docker's default 64MB `/dev/shm`), `PAIRETO_DOCKER=1`, and a readiness healthcheck.
- `docker-compose.e2e.yml` — E2E-only overlay: mounts the staged Claude secret (`./.secrets`, read-only
  at `/paireto-secrets`) plus `~/.codex`, `~/.local/share/opencode`, `~/.config/opencode`.
- `docker-compose.mock.yml` — adds MockServer for provider recording/replay. Record combines this with
  the credential overlay; check deliberately does not, seeds fake auth, installs a strict 599 catch-all,
  and runs with MockServer in `SIMULATE` mode so a fixture miss cannot reach a provider.
- `prepare-e2e.sh` — host-side; stages `~/.claude.json` + the keychain OAuth credential into `./.secrets`
  (gitignored, 0600, contents never printed) so the Linux container can authenticate Claude without a
  keychain. Run automatically by `test:e2e:docker`.

`PAIRETO_DOCKER=1` makes both runners (`.vscode-test.mjs` and `src/e2e/runE2E.ts`) pass `--no-sandbox`
to Electron — required because it runs as root and Docker has no usable namespace sandbox. That flag is
inert on a native macOS run (the env var is unset there), so `pnpm test` locally is unchanged.

## Notes

- Comment out any credential line in `docker-compose.e2e.yml` for a harness you don't use.
- To reset the cached install / VS Code download: `pnpm docker:down` then
  `docker volume rm docker_paireto-node-modules docker_paireto-vscode-test`.

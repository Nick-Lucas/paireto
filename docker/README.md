# Headless tests in Docker

Both Paireto test suites launch a real VS Code (Electron) window via `@vscode/test-electron`. On macOS
that window pops up and steals focus on every run. Running the suites inside a **Linux container with a
virtual X display (`xvfb`)** makes them fully headless — no window ever reaches the macOS host.

The container is **persistent**: you boot it once, and it keeps your code + dependencies mounted from
the host while you send test commands into it (streaming their output back). No rebuild per run.

## Prerequisites

- Docker with `docker compose`)

## Commands

```sh
pnpm docker:build          # build the image once (Node deps' Linux runtime + the 3 harness CLIs)

pnpm test:docker           # boots the container (if needed) and runs the unit suite in it
pnpm docker:shell          # a bash shell inside the running container
pnpm docker:down           # stop everything (the test container plus MockServer, if an E2E run left it up)

# Strict credential-free replay of the WHOLE (case × driver) matrix, one window per pair.
pnpm e2e:check:docker

# Narrow it with Mocha's own flags, matched against the `<case> @<driver>` suite titles.
pnpm e2e:check:docker --grep @codex
pnpm e2e:check:docker --grep 'fullflow @codex'

pnpm e2e:check:docker --grep 'guidedreview @claudecode'

# Recording talks to the real provider and replaces the cassette of every pair it runs — so filter
# it unless you mean to re-record the whole matrix, which costs a paid run per pair.
pnpm e2e:record:docker --grep @claudecode
```

Replay fails a pair with no committed cassette — a driver that never launched must not be able to
report a pass. Recording that pair is how you add it.

`test:docker` / `e2e:record:docker` each do `docker compose up -d --wait` (a no-op once booted) and then
`docker compose exec` the suite — so the first run pays the boot cost and later runs are just the exec.
After adding or upgrading a dependency, run `docker compose … exec tests pnpm install` (or
`pnpm docker:down` and let the next run reinstall) — `node_modules` is a cached named volume, so the
entrypoint only populates it when it is empty.
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
- `e2e.sh` — the one entry point for both E2E flows: picks the compose overlays for the mode, boots
  once, then execs the run with the per-run variables attached. `ANTHROPIC_API_KEY` is forwarded only
  in record mode, so a check run cannot reach a real provider even if the key is exported.
- `docker-compose.e2e.yml` — E2E-only overlay: mounts the staged Claude secret (`./.secrets`, read-only
  at `/paireto-secrets`) plus `~/.codex`, `~/.local/share/opencode`, `~/.config/opencode`.
- `docker-compose.mockserver.yml` — adds MockServer for every E2E run. Record combines this with
  the credential overlay; check deliberately does not, seeds fake auth, installs a strict 599 catch-all,
  and runs with MockServer in `SIMULATE` mode so a fixture miss cannot reach a provider.
- `prepare-e2e.sh` — host-side; stages `~/.claude.json` + the keychain OAuth credential into `./.secrets`
  (gitignored, 0600, contents never printed) so the Linux container can authenticate Claude without a
  keychain. Run automatically by `e2e:record:docker`.

`PAIRETO_DOCKER=1` makes both runners (`.vscode-test.mjs` and `src/e2e/runE2E.ts`) pass `--no-sandbox`
to Electron — required because it runs as root and Docker has no usable namespace sandbox. That flag is
inert on a native macOS run (the env var is unset there), so `pnpm test` locally is unchanged.

## Notes

- Comment out any credential line in `docker-compose.e2e.yml` for a harness you don't use.
- To reset the cached install / VS Code download: `pnpm docker:down` then
  `docker volume rm docker_paireto-node-modules docker_paireto-vscode-test`.

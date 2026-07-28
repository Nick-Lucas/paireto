# Paireto E2E suite

## Architecture

Drives the full **plan → feedback → approve → implement → review-feedback → review-approve** loop
inside a real VS Code window, over the per-repo Unix socket — the same substrate the product uses.

- The test (`tests/fullflow.e2e.ts`) runs inside the extension host (`@vscode/test-electron`,
  launched by `runE2E.ts`). It plays the **user** side via the real `paireto.gate.*` commands and an
  env-gated test control plane (`src/testControlPlane.ts`, active only when `PAIRETO_TEST=1`):
  `paireto.test.inspect` (state snapshot) + `paireto.test.addComment`.
- A **`HarnessDriver`** (`drivers/`) plays the agent side — it launches the real TUI/server for its
  harness and performs only pre-flow setup such as activating its reviewed-plan workflow. Steps branch on `DriverCaps`
  (e.g. blocking vs post-hoc turn-end review). Drivers never act after a Paireto approval.
- Assertions read only the socket-observed state (`inspect`) and the sandbox filesystem — **nothing
  is scraped from a terminal.**
- A throwaway git repo (`sandbox.ts`) is the workspace; `XDG_STATE_HOME` is a **short `/tmp` dir**
  (the socket path must stay under macOS's ~104B `sun_path` limit). A fresh `--user-data-dir`
  isolates VS Code state.

## Running

All E2E and unit tests for this workflow run in the Docker `tests` service. Pick a driver — there is
no default:

```sh
pnpm docker:build
PAIRETO_E2E_DRIVER=claudecode pnpm test:e2e:docker
PAIRETO_E2E_DRIVER=codex      pnpm test:e2e:docker
PAIRETO_E2E_DRIVER=opencode   pnpm test:e2e:docker
```

`test:e2e` = `pnpm compile` + `pnpm compile-tests` + `node out/e2e/runE2E.js`. The default unit suite
(`pnpm test`) globs `out/test/**` and never picks up `out/e2e/**`, so the two stay independent.

## Where check runs

Cassettes are recorded in the Docker container. `pnpm e2e:check:docker` is authoritative and covers
every driver; a native `pnpm e2e:check` works for **claudecode and opencode** and warns up front when
the cassette's platform differs.

Mock runs use `/private/tmp` (`mockTmpRoot`) — canonical on macOS and in the container alike — so the
sandbox and harness homes are spelled identically wherever the run happens. What remains platform-
specific is the _output_ of shell commands the agent runs: `od` pads columns differently under BSD
and GNU, and that output becomes the next request. It is content the model reasons about rather than
noise, so it is not normalized, and native **codex** replay fails on it.

## When a replay misses

A strict-VCR miss ends the run immediately and prints the differing lines against the cassette entry
it came closest to matching, so the failure names the field that changed:

```
LIKELY CAUSE: strict VCR miss: no cassette entry matched POST /backend-api/codex/responses
closest cassette entry: #4
--- cassette
+++ replayed request
@@ line 135 @@
-      "id": "msg_019fdc62-…"
+      "id": "msg_019fdc7a-…"
```

Either normalize the field (if it varies per run) or re-record. `PAIRETO_SHIM_DUMP=<dir>` writes every
normalized match key to a file for a fuller comparison. Only the harness's own inference endpoints end
the run; offline 599s on incidental traffic (a model catalogue, a package registry) are expected.

## Watching the agent

Every run streams the agent's screen to stdout as it changes, prefixed with the driver name, so a
passing run shows the work and a stall shows where it stopped. `PAIRETO_E2E_WATCH=0` silences it.

The tmux drivers (claudecode/codex) also print an attach command at launch, for watching the TUI live:

```sh
tmux -L pai-e2e-<run> attach -t main -r                                    # native
docker compose -f docker/docker-compose.yml exec tests tmux -L … -r       # in Docker
```

Attach **read-only** (`-r`, as printed). A writable client shares the pane with the driver, so a
stray keystroke lands in the agent's prompt. The session is pinned to `window-size manual`, so
attaching from a smaller terminal cannot reflow the pane the driver reads.

Each live run **uses the selected subscription** and takes ~1–3 min. You picked the driver, so if its
binary/auth is missing the run **FAILs** with the reason (`E2E: FAIL — driver "<x>" cannot run:
<reason>`) — never a silent skip.

All three drivers must complete the full flow. Codex uses native Plan mode. Plan feedback returns a
supported Stop `decision:"block"`, which Codex turns into a new continuation prompt using the hook's
reason. Plan approval emits no hook output and finishes the turn. Codex Stop hooks receive
`permission_mode` but cannot output a collaboration-mode change; `PermissionRequest` approval applies
to tool escalations, not the native Plan transition. Codex therefore shows "Implement this plan?",
and the driver selects its pre-highlighted approve-and-switch option as the simulated user. If that
selector does not appear, the test fails.
See the official [Codex Hooks reference](https://developers.openai.com/codex/hooks/) for the Stop and
PermissionRequest input/output contracts.

## Provider replay: record once, check forever (no creds)

`PAIRETO_E2E_MODE` (default `live`) routes the harness's LLM traffic through a **MockServer** container
acting as a **transparent MITM forward proxy** (`src/e2e/mockserver/`). The harness keeps talking to its
real provider with its real credentials — MockServer just sits in the network path — so recording uses
your **local subscription** and needs no config change, and replay runs with **no credentials and no
network**:

```sh
PAIRETO_E2E_DRIVER=claudecode pnpm e2e:record:docker # real provider → record fixture
PAIRETO_E2E_DRIVER=claudecode pnpm e2e:check:docker  # strict offline replay, fake auth
```

How it works:

- Drivers set `HTTP(S)_PROXY`/`ALL_PROXY` to a test-only MITM shim and trust its CA via
  `NODE_EXTRA_CA_CERTS` / `SSL_CERT_FILE`. The first mock run generates a ten-year CA and leaf identity
  in the ignored, private `src/e2e/proxy/certs/` directory; later runs validate and reuse it, replacing
  it automatically only when it is unusable or near expiry. The CA signing key is deleted immediately,
  so the directory retains one mode-0600 leaf key. No private key is committed or generated during
  package installation; only MockServer's public built-in CA certificate is vendored. `NO_PROXY` keeps
  loopback (OpenCode's `serve`/`attach`) direct. Codex always pins `gpt-5.6-luna` and uses a custom
  transport provider with the normal ChatGPT backend and `requires_openai_auth = true`, preserving
  subscription OAuth while forcing replayable SSE instead of WebSocket attempts.
- **record** = `CAPTURE` (proxy forwards each request to its real host and records it), then
  `promote_recordings` → retrieve the expectations → strip volatile matchers → commit the fixture.
  Works against the OAuth subscription for **all three** harnesses.
- **check** = load `fixtures/fullflow.<driver>.json` plus local startup responses, add a lowest-priority
  599 catch-all, then enable `SIMULATE`. The check compose overlay mounts no user credentials; each
  harness gets syntactically valid, far-future fake OAuth state. Drift fails loud and cannot hit a
  real API. The sandbox repo and harness homes use fixed `/tmp` paths so request bodies reproduce.
- Request matchers discard provider headers and narrowly canonicalize account/environment metadata,
  prompt-cache controls, and deterministic workflow tool-result wording. User prompts, model messages,
  tool names/calls/arguments, and file contents remain strict.
- The tool inventory is **reduced, not erased**: every tool keeps its name (sorted), and **Paireto's
  own tools keep their full schema**, so a regression that stopped offering them — or shipped a broken
  `paireto_submit_plan` schema — fails replay instead of quietly matching. Only the provider's
  free-text descriptions and built-in schemas are dropped.
- Stored response headers use a whitelist: only canonical `Content-Type` is retained. All cookie
  headers and any future provider-specific headers are discarded before a fixture is written.
- **Identity is scrubbed on both sides.** Requests go through `scrubIdentity` inside the shared
  normalizer (so cassette and live request are scrubbed identically and matching is unaffected);
  response bodies are scrubbed at write time. The guarantee isn't the denylist — `fixturePrivacy.test.ts`
  scans every committed cassette for anything email- or account-id-shaped and fails the build.
- **Cassettes record the harness version they were captured with.** The Docker image installs the
  agent CLIs unpinned (running against latest is the point), so on a check failure the runner reports
  `recorded with X, running Y — re-record` rather than leaving a strict-VCR miss as a bare timeout.
- Captured Responses streams are saved with only the essential endpoint traffic. Replay strips
  MockServer capture-only chunk metadata, restores `text/event-stream`, and closes after the complete
  `response.completed` block so both Codex and OpenCode terminate reliably.
- MockServer runs as its official Docker image (no host JVM); native runs `docker run` it, the Docker
  flow uses a compose service (`docker/docker-compose.mock.yml`). See `src/e2e/fixtures/README.md`.

## Prerequisites / setup

Each driver builds a throwaway home seeded with a **copy** of your real credentials (chmod 600,
deleted in teardown, contents never logged). Your real `~/.codex`, `~/.config/opencode`, `~/.claude`
are never written.

| driver       | binary            | auth material                                                                  |
| ------------ | ----------------- | ------------------------------------------------------------------------------ |
| `claudecode` | `claude` + `tmux` | `~/.claude.json` + keychain `Claude Code-credentials` (or `ANTHROPIC_API_KEY`) |
| `codex`      | `codex` + `tmux`  | `~/.codex/auth.json`                                                           |
| `opencode`   | `opencode`        | `~/.local/share/opencode/auth.json` (built-in OpenAI OAuth provider)           |

- `claudecode` / `codex` need **tmux** on PATH for startup keystrokes and failure-screen capture.
- `opencode` runs a persistent `opencode serve` + one `opencode run --attach` turn with
  `openai/gpt-5.6-luna`. Record/check use an empty temporary config plus only the bundled Paireto
  plugin; live mode may copy the user's config.

## Running headless in Docker

The Linux container supplies the virtual display and is the supported test entry point — see
[`docker/README.md`](../../docker/README.md):

```sh
pnpm docker:build
PAIRETO_E2E_DRIVER=claudecode pnpm test:e2e:docker
```

Live/record credentials are mounted or staged read-only. Claude's keychain OAuth credential is staged
by `docker/prepare-e2e.sh`; Codex and OpenCode receive their read-only auth files from the E2E overlay.
`e2e:check:docker` deliberately omits those mounts and uses fake local auth only.

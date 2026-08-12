# Paireto E2E suite

## Architecture

Drives a whole Paireto loop inside a real VS Code window, over the per-repo Unix socket — the same
substrate the product uses.

- The specs (`tests/*.e2e.ts`, shared step helpers in `tests/steps.ts`) run under **Mocha** inside the
  extension host, so each step is reported by name and a case scaffolds itself in
  `suiteSetup`/`suiteTeardown` (launching and disposing its driver). Steps share one agent session, so
  they run in order and the run uses `bail` — once a step fails the rest are noise. They play the
  **user** side via the real `paireto.gate.*` commands and an env-gated test control plane
  (`src/testControlPlane.ts`, active only when `PAIRETO_TEST=1`): `paireto.test.inspect` (state
  snapshot) + `paireto.test.addComment`.
- **A case is a spec file; the drivers are a matrix.** Each suite is titled `<case> @<driver>`, so
  one Mocha pattern selects pairs out here and tests inside the window. There is no selection env
  var. One pair runs per window, because each needs its own sandbox repo and its own cassette, both
  armed before VS Code starts.
- **`runE2E.ts` owns everything around the window**, but not the window itself: it builds the sandbox
  and arms MockServer, then hands the launch to the `vscode-test` CLI (`.vscode-test.e2e.mjs`). That
  config is deliberately separate from `.vscode-test.mjs` so `pnpm test` and the VS Code Test Explorer
  cannot start a run that has no proxy to talk to.
- A **`HarnessDriver`** (`drivers/`) plays the agent side — it launches the real TUI/server for its
  harness and performs only pre-flow setup such as activating its reviewed-plan workflow. Steps branch on `DriverCaps`
  (e.g. blocking vs post-hoc turn-end review). Drivers never act after a Paireto approval.
- Assertions read only the socket-observed state (`inspect`) and the sandbox filesystem — **nothing
  is scraped from a terminal.**
- A throwaway git repo (`sandbox.ts`) is the workspace; `XDG_STATE_HOME` is a **short `/tmp` dir**
  (the socket path must stay under macOS's ~104B `sun_path` limit). A fresh `--user-data-dir`
  isolates VS Code state.

## Running

All E2E and unit tests for this workflow run in the Docker `tests` service. An unfiltered run covers
the whole matrix; narrow it with Mocha's own flags, which are forwarded through:

```sh
pnpm docker:build
pnpm e2e:check:docker                            # every case × every driver

pnpm e2e:check:docker --grep @codex              # one driver, every case
pnpm e2e:check:docker --grep '^fullflow '        # one case, every driver
pnpm e2e:check:docker --grep 'fullflow @codex'   # exactly one pair
pnpm e2e:check:docker --grep guidedreview        # the guided-review case

# Recording replaces the cassette of every pair it runs, at the price of a real provider call each.
pnpm e2e:record:docker --grep @claudecode
```

A pattern is matched against the suite titles — `<case> @<driver>` — first out here to choose which
windows to open, then again by Mocha inside each one. So it selects whole pairs; a pattern aimed at
individual test names has no pair to open and is reported as matching nothing.

The filter travels as arguments to the `docker compose exec` (see `docker/e2e.sh`), not as container
configuration, so narrowing a run never recreates the container.

`e2e:record` records the provider traffic and replaces that driver's cassette after a passing run. It
runs `pnpm compile` + `pnpm compile-tests` + `PAIRETO_E2E_MODE=record node out/e2e/runE2E.js`. The default unit suite
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

The one exception is the ORDER of a directory listing (`find`, `ls`), which is a property of the
machine's filesystem rather than of the tree — two hosts holding identical files report them
differently, so a cassette recorded on one missed on another. Those lines are sorted before matching.
Every path still has to be present, so a listing that gained or lost one still fails.

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

Each recording run **uses the selected subscription** and takes ~1–3 min. You picked the driver, so if its
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

`PAIRETO_E2E_MODE` supports `record` (the default) and `check`. Every run routes the harness through a
native Node.js **normalizing shim**, then a **MockServer** container acting as a transparent MITM
forward proxy (`src/e2e/mockserver/`). The harness keeps talking to its real provider host. Recording
uses your real credentials and **local subscription**; replay uses no credentials and no network:

```sh
pnpm e2e:record:docker --grep @claudecode # real provider → record fixture
pnpm e2e:check:docker  --grep @claudecode # strict offline replay, fake auth
```

How it works:

- Drivers always set `HTTP(S)_PROXY`/`ALL_PROXY` to the test-only MITM shim and trust its CA via
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
  The shim passes request bodies through unchanged. This works against the OAuth subscription for
  **all three** harnesses.
- **check** = load `fixtures/<case>.<driver>.json` plus local startup responses, add a lowest-priority
  599 catch-all, then enable `SIMULATE`. The check compose overlay mounts no user credentials; each
  harness gets syntactically valid, far-future fake OAuth state. Drift fails loud and cannot hit a
  real API. The shim applies the selected driver's normalizer before matching. The sandbox repo and
  harness homes use fixed `/tmp` paths so request bodies reproduce, and the sandbox's initial commit
  is dated from a fixed point so its commit id does too — an agent that runs `git log` puts that id
  straight into its next request.
- Request matchers discard provider headers and narrowly canonicalize account/environment metadata,
  prompt-cache controls, deterministic workflow tool-result wording, and the order (never the
  contents) of a directory listing. User prompts, model messages, tool names/calls/arguments, and
  file contents remain strict.
- The tool inventory is **reduced, not erased**: every tool keeps its name (sorted, because the
  advertised order varies between runs), and **Paireto's own tools are kept whole — description and
  schema** — so a regression that stopped offering them, or shipped a broken `paireto_submit_plan`
  schema, fails replay instead of quietly matching. Every other tool is reduced to its name, since
  provider descriptions and built-in schemas churn each CLI release. One normalizer serves all three
  harnesses, so none of them can drift from this.
- Stored response headers use a whitelist: only canonical `Content-Type` is retained. All cookie
  headers and any future provider-specific headers are discarded before a fixture is written.
- **Identity is scrubbed on both sides.** Requests go through `scrubIdentity` inside the shared
  normalizer (so cassette and replay request are scrubbed identically and matching is unaffected);
  response bodies are scrubbed at write time. The guarantee isn't the denylist — `fixturePrivacy.test.ts`
  scans every committed cassette for anything email- or account-id-shaped and fails the build.
- **Cassettes record the harness version they were captured with.** The Docker image installs the
  agent CLIs unpinned (running against latest is the point), so on a check failure the runner reports
  `recorded with X, running Y — re-record` rather than leaving a strict-VCR miss as a bare timeout.
- Captured Responses streams are saved with only the essential endpoint traffic. Replay strips
  MockServer capture-only chunk metadata, restores `text/event-stream`, and closes after the complete
  `response.completed` block so both Codex and OpenCode terminate reliably.
- MockServer runs as its official Docker image (no host JVM); native runs `docker run` it, the Docker
  flow uses a compose service (`docker/docker-compose.mockserver.yml`). The shim itself is a Node.js server
  in the E2E runner process. See `src/e2e/fixtures/README.md`.

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
  `openai/gpt-5.6-luna`. Both modes use an empty temporary config plus only the bundled Paireto plugin.

## Running headless in Docker

The Linux container supplies the virtual display and is the supported test entry point — see
[`docker/README.md`](../../docker/README.md) for the container itself (volumes, boot, shell access):

```sh
pnpm docker:build                                    # once

pnpm e2e:record:docker --grep @claudecode # record and replace the cassette
pnpm e2e:check:docker  --grep @claudecode # strict offline replay, no credentials

pnpm test:docker                                     # the unit suite
pnpm docker:down                                     # stop the container
```

Record credentials are mounted or staged read-only. Claude's keychain OAuth credential is staged
by `docker/prepare-e2e.sh`; Codex and OpenCode receive their read-only auth files from the E2E overlay.
`e2e:check:docker` deliberately omits those mounts and uses fake local auth only.

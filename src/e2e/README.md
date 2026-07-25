# Paireto E2E suite

Exercises everything Paireto ships — the `plugins/**` hook scripts **and** the VS Code extension —
end to end inside a real VS Code window, over the per-repo Unix socket. The recorded boundary is
**harness ↔ hooks**: only the terminal AI agent is real (record) or synthetic (replay); the plugin +
extension are real in both modes.

## Architecture

A set of components layered around one always-real core.

- **Sandbox** (`sandbox.ts`) — the isolated world each run gets: a throwaway git repo (the VS Code
  workspace folder), a fresh `--user-data-dir`, and a **short `/tmp` `XDG_STATE_HOME`** (the socket
  path must stay under macOS's ~104-byte `sun_path` limit). Record runs additionally seed a throwaway
  per-harness home from a **copy** of your real credentials (chmod 600, deleted in teardown, never
  logged). `runE2E.ts` builds the sandbox and launches a real VS Code via `@vscode/test-electron`.
- **Extension + Unix socket** (always real, both modes) — the product under test. The extension binds
  the per-repo socket, and that socket is the whole substrate: the plugin dials it, blocking gate
  requests park on it, and the user side resolves them through the real `paireto.gate.*` commands.
  Nothing here is stubbed in either mode.
- **Test control plane** (`src/testControlPlane.ts`) — commands registered only when `PAIRETO_TEST=1`:
  `paireto.test.inspect` (a socket-observed state snapshot) and `paireto.test.addComment`. It is the
  observation/injection window into the running extension; there is **zero product surface** when the
  env flag is unset, and nothing is ever scraped from a terminal.
- **Drivers** (`drivers/`) — one per harness. A driver launches and steers the **real** agent: the
  claude/codex TUIs run in an external tmux session (send-keys + capture-pane, needed for the
  hook-invisible TUI selectors), opencode runs `opencode serve` plus one attached turn. `DriverCaps`
  captures the harness-shape differences. Drivers are consulted only in record mode.
- **Recorder service + generated shims** (record) — `RecorderService` is a tiny in-test unix-socket
  collector. At record time the recorder **generates** shims into the sandbox (from TS template
  strings — never committed `.js`): claude/codex get a `--plugin-dir` copy whose `hooks.json` /
  `.mcp.json` point at hook + proc shims, opencode gets a wrapper plugin that imports the real
  `paireto.js`. Each shim spawns/invokes the REAL plugin script/server and reports what crossed the
  boundary (env, stdin, stdout, exit; plugin hook in/out; SDK calls) to the service, which serializes
  arrivals and builds the tape. `RecordingDriver` wraps the real driver so a run records transparently.
- **Replay emulators** (replay) — `HookHarnessEmulator` (claude/codex) and `OpenCodePluginHost`
  (opencode), both behind `ReplayDriver` over a shared `TapeExecutor`. They **replace the harness**:
  the emulator reads the tape and, in the harness's place, spawns the REAL hook scripts as `node`
  children / invokes the REAL plugin in-process against the REAL socket + extension, comparing each
  recorded response. `TapeExecutor` owns the sequential loop, the driver-checkpoint rendezvous, and the
  divergence diff.
- **Tapes** (`recordings/fullflow.<harness>.json`) — the committed event streams a record run
  produces and a replay run consumes. See [`recordings/README.md`](recordings/README.md) for the schema.

**How they interact.** In **record**, the sandbox stands up the real world, the driver runs the real
harness, and the harness's hook calls flow through the generated shims into the real plugin → real
socket → real extension while the recorder service tees every boundary crossing into a tape. In
**replay**, the sandbox + extension + socket are identical, but the emulator takes the harness's place
from the tape — driving the same real plugin against the same real extension with no harness, tmux, or
credentials in the loop.

## Running

Pick a driver — there is no default:

```sh
PAIRETO_E2E_DRIVER=claudecode pnpm test:e2e
PAIRETO_E2E_DRIVER=codex      pnpm test:e2e
PAIRETO_E2E_DRIVER=opencode   pnpm test:e2e
```

`test:e2e` = `pnpm compile` + `pnpm compile-tests` + `node out/e2e/runE2E.js`. The default unit suite
(`pnpm test`) globs `out/test/**` and never picks up `out/e2e/**`, so the two stay independent.

Every run defaults to **replay**, which needs only node + VS Code + a committed tape (no harness, tmux,
or credentials), so a stripped-PATH box runs it. In replay a driver is "available" iff its tape exists;
a missing tape **SKIPs** with a visible reason (`E2E: SKIP driver "<x>" — <reason>`), never fails.
**Record** mode is the opposite: it requires the real harness and **HARD-FAILS** (never skips) when the
binary/auth/tmux is missing — see the next section.

## Record / replay (`PAIRETO_E2E_RECORDER_MODE`, default `replay`)

Every run goes through the **HarnessRecorder** (`recorder/`), which has two modes:

```sh
PAIRETO_E2E_DRIVER=claudecode pnpm test:e2e                              # replay (default)
PAIRETO_E2E_RECORDER_MODE=record PAIRETO_E2E_DRIVER=claudecode pnpm test:e2e   # record (live)
```

The recorded boundary is **harness ↔ hooks**: the extension + unix socket stay real in both modes, and
everything Paireto ships (`plugins/**` + the extension) is exercised in both — only the harness is
synthetic in replay.

- **`record` (the live run):** the real harness runs behind recording **shims** (generated into the
  sandbox at record time) that spawn the REAL plugin scripts/server and report to a tiny in-test
  recorder service. On a **passing** run it normalizes (machine paths → `{{PLACEHOLDER}}`s), lint-checks
  for residual paths, enforces an empty-tape guard, writes the committed tape, and prints a
  **behaviour-change report**. Costs cents, ~1–3 min. Record mode **HARD-FAILS** (never skips) when a
  harness binary/auth is missing. On failure it dumps a partial tape to a temp path and never overwrites
  the committed one.
- **`replay` (default):** re-drives the REAL plugin against the REAL extension, emulating only the
  harness from the tape. `HookHarnessEmulator` (claude/codex) spawns the real hook scripts as `node`
  child processes — materializing `{{FILE:n}}` aux inputs, denormalizing env/stdin so the real
  `bridge.js` dials the REAL socket, comparing each hook's stdout + exit code — and drives the claude
  MCP liveness `proc`. `OpenCodePluginHost` (opencode) dynamic-imports the real `paireto.js` in-process
  with a fake ctx (tape-backed `client` stub, inert `$`) and invokes its hooks/tools, comparing the
  config/system-transform mutation deltas and tool/client results. Both run behind `ReplayDriver` over
  the shared `TapeExecutor` (sequential loop + driver checkpoints + divergence diff). Replay needs
  nothing but node + VS Code + system git — no harness binary, no auth — so a stripped-PATH CI box runs
  it; `isAvailable()` is just "does a committed tape exist". Fast (seconds).

Re-record a harness whenever its wire behaviour legitimately changes; review the report + `git diff`
of the tape. See [`recordings/README.md`](recordings/README.md) for the tape schema, the opencode
event-ordering caveat, and how to read a divergence.

## Prerequisites / setup

(These apply to **record** runs only — **replay** needs none of them.)


Each driver builds a throwaway home seeded with a **copy** of your real credentials (chmod 600,
deleted in teardown, contents never logged). Your real `~/.codex`, `~/.config/opencode`, `~/.claude`
are never written.

| driver | binary | auth material |
| --- | --- | --- |
| `claudecode` | `claude` + `tmux` | `~/.claude.json` + keychain `Claude Code-credentials` (or `ANTHROPIC_API_KEY`) |
| `codex` | `codex` + `tmux` | `~/.codex/auth.json` |
| `opencode` | `opencode` | `~/.local/share/opencode/auth.json` + `~/.config/opencode` (opencodex plugin) |

- `claudecode` / `codex` need **tmux** on PATH (keystroke fidelity + screen readback for
  hook-invisible TUI selectors).
- `opencode` runs a persistent `opencode serve` + one `opencode run --attach` turn; its model
  (`openai/gpt-5.5-fast`, a Codex-subscription model via the opencodex plugin) is copied from your
  real `~/.config/opencode`.

# Paireto E2E suite

## Architecture

Drives the full **plan → feedback → approve → implement → review-feedback → review-approve** loop
inside a real VS Code window, over the per-repo Unix socket — the same substrate the product uses.

- The test (`tests/fullflow.e2e.ts`) runs inside the extension host (`@vscode/test-electron`,
  launched by `runE2E.ts`). It plays the **user** side via the real `paireto.gate.*` commands and an
  env-gated test control plane (`src/testControlPlane.ts`, active only when `PAIRETO_TEST=1`):
  `paireto.test.inspect` (state snapshot) + `paireto.test.addComment`.
- A **`HarnessDriver`** (`drivers/`) plays the agent side — it launches the real TUI/server for its
  harness and drives it. Steps branch on `DriverCaps` (e.g. blocking vs post-hoc turn-end review).
- Assertions read only the socket-observed state (`inspect`) and the sandbox filesystem — **nothing
  is scraped from a terminal.**
- A throwaway git repo (`sandbox.ts`) is the workspace; `XDG_STATE_HOME` is a **short `/tmp` dir**
  (the socket path must stay under macOS's ~104B `sun_path` limit). A fresh `--user-data-dir`
  isolates VS Code state.

## Running

Pick a driver — there is no default:

```sh
PAIRETO_E2E_DRIVER=claudecode pnpm test:e2e
PAIRETO_E2E_DRIVER=codex      pnpm test:e2e
PAIRETO_E2E_DRIVER=opencode   pnpm test:e2e
```

`test:e2e` = `pnpm compile` + `pnpm compile-tests` + `node out/e2e/runE2E.js`. The default unit suite
(`pnpm test`) globs `out/test/**` and never picks up `out/e2e/**`, so the two stay independent.

Each run **costs cents** (real LLM calls) and takes ~1–3 min. A driver whose binary/auth is missing
**SKIPs** with a visible reason (`E2E: SKIP driver "<x>" — <reason>`), never fails.

## Prerequisites / setup

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

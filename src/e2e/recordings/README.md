# E2E tapes (`fullflow.<harness>.json`)

Each file here is a **tape**: the ordered event stream of one full-flow E2E run, captured at the
**harness ↔ hooks** boundary and normalized so it replays against the **real** plugin + extension with
**no harness, no tmux, no credentials**. The recorded thing is what the harness drove the plugin
scripts/plugin to do — the extension + unix socket stay entirely real. See
[`../README.md`](../README.md) for the mode overview and the `recorder/` code.

## What's in a tape

Canonical (recursively sorted-key) pretty JSON. `events[]` is a flat, `seq`-numbered
list in arrival order:

- `hook.start` / `hook.end` (claude + codex) — one hook invocation. `start` carries the repo-relative
  `script`, the allowlisted `env`, `cwd`, the raw `stdin` JSON, and (codex Stop only) `files` aux
  inputs keyed by `{{FILE:n}}`; `end` carries the hook's `stdout` + `exit` and any working-tree `fs`
  delta. `inv` correlates the pair. A blocking gate hook's `end` lands after the test acts — the true
  interleaving is preserved.
- `proc.start` / `proc.stop` — a long-lived harness-launched process (the claude MCP liveness
  `server.js`); `stop` fires when its recorder connection drops (process death).
- `plugin.load` / `plugin.hook` / `plugin.tool.start` / `plugin.tool.end` / `client.call` (opencode) —
  the plugin's harness-facing surface: the factory call, each hook (with a before/after mutation delta
  for `config` + `experimental.chat.system.transform`), each blocking custom tool's execute, and the
  plugin→OpenCode SDK calls (`session.prompt` / `app.agents` / `session.messages`).
- `driver` — a checkpoint (`launch` / `enterPlanMode` / `prompt` / `afterPlanApprove`).
- `fs.final` — the final working-tree delta.

Machine-specific literals are placeholderized (`{{REPO}}`, `{{STATE}}`, `{{USER_HOME}}`, harness homes,
`{{REPO_DASHED}}`, …). The plugin version is `{{V}}`; codex rollout-transcript aux files are `{{FILE:n}}`.
Session/request ids and plan markdown stay **verbatim**.

## (Re)recording

```sh
PAIRETO_E2E_RECORDER_MODE=record PAIRETO_E2E_DRIVER=<harness> pnpm test:e2e
```

Records the live harness run behind the recording shims and, **on a passing run only**, rewrites
`fullflow.<harness>.json` and prints a behaviour-change report. Record mode **requires** that harness's
binary + auth (it HARD-FAILS if missing — never skips) and **refuses to write an empty tape** (a
silently-skipped shim, e.g. a wrong codex trust hash, must never yield a "passing" empty record). A
fresh LLM recording carries benign churn (ids, timestamps, plan text); the opencode driver may retry
once in a fresh session, in which case record refuses to write the noisy tape and asks you to re-run.

## Reading the behaviour-change report

Printed at the end of a record run, it compares the new tape against the committed one:
**structural changes** (event kinds + script/hook/tool names added/removed/reordered, invocation
numbers ignored) or, when the shape is unchanged, **changed responses** (a `hook.end` stdout gate
decision, a `plugin.tool.end` result, or a `client.call` result flipping). "Only benign churn" means
ids/timestamps/plan text moved but behaviour didn't. Always points at `git diff` for the full view.

## Break-glass drills (prove the boundary is real)

These are one-off sanity checks — each is applied, run, and then **fully reverted**. They confirm the
tape drives behaviour and that the plugin/hook scripts are genuinely under test (not stubbed):

- **Flip a recorded gate decision.** Hand-edit a `hook.end` `stdout` in a tape (e.g. a gate
  `decision` value). Replay fails naming the invocation with a key-path diff
  (`inv N (seq S) stdout diverged … differing paths: decision`).
- **Break a plugin script.** Temporarily change a real hook script (e.g. invert the plan/review fork in
  `plugins/codex/scripts/on-stop-gate.js`). Replay CATCHES it — the wrong gate opens (or none does),
  the test times out on the missing gate, and the affected `hook.end` stdout diverges. This is the
  whole point of the harness↔hooks boundary: the shipped scripts run for real in replay.
- **Delete a `hook.end`.** Remove one end event. The executor never parks on that invocation, races
  ahead, and `screen()` names the gap (`blocked on hook end inv X — hooks inflight: …`) while the test
  times out waiting for the gate that never resolved.
- **Record with the harness missing.** Run record with the harness binary off PATH (VS Code re-resolves
  the login-shell PATH, so masking usually means renaming the binary). Record **HARD-FAILS** with a
  clear message (`E2E RECORD: cannot record "<h>" — <h> binary not on PATH …`), never a silent skip,
  and never overwrites the committed tape.

## Notes

- **Replay** (the default `pnpm test:e2e`) re-drives the REAL plugin scripts (claude/codex hooks) or
  the REAL plugin in-process (opencode) against the REAL extension, emulating only the harness from the
  tape — `HookHarnessEmulator` / `OpenCodePluginHost` behind `ReplayDriver`. It needs nothing but node +
  VS Code + system git (no harness binary, no auth), so it runs on a stripped-PATH CI box. A divergence
  (a hook's stdout / a plugin hook's mutation / a tool or client result flipping) fails the run with a
  readable diff naming the invocation.
- **OpenCode ordering caveat.** The opencode plugin forwards events to the recorder fire-and-forget over
  one serial socket, so a tape's event ORDER is not strictly causal (a streaming turn's backlog lags,
  and the post-hoc feedback injection lands near the end). Replay is robust to this: `client.call`s are
  matched PER PATH (session.prompt / session.messages / app.agents) rather than by a single FIFO, and
  after each `session.idle` event hook the executor parks until the post-hoc review gate it opened
  resolves (reproducing the real-time separation the two review gates had during record).
- **Do not hand-edit** a tape except to stage a deliberate divergence drill (revert afterwards).

# Dev scripts

Repo-local development tooling. **Not shipped in the `.vsix`** — these live outside `plugins/` so
the whole plugin folder can be bundled as-is (`!plugins/**` in `.vscodeignore`).

## Bridge emulator (manual testing without an agent)

`emulator.ts` is a zero-dependency CLI that plays the plugin side of the wire protocol, so you can
drive every VS Code flow — telemetry, the plan gate, the code-review round-trip — by hand, no Claude
Code TUI required. It reuses the plugin's `bridge.js`, so socket resolution is identical to the real
hooks, and runs directly on Node's built-in TypeScript type-stripping (Node ≥ 22.18 / 23.6 — no
compile step). Run it from inside a repo you've opened in VS Code:

```
pnpm emulator doctor                       # resolve the socket + handshake — start here
pnpm emulator event PreToolUse --tool Bash # one fire-and-forget telemetry event
pnpm emulator plan                         # ExitPlanMode gate; blocks for Approve/Send Feedback
pnpm emulator review                       # paireto_review session; blocks for Send Feedback/Cancel
pnpm emulator flow                         # a full simulated session lifecycle of events
pnpm emulator help                         # all commands + options
```

(`pnpm emulator <cmd>` runs `node scripts/emulator.ts <cmd>`.) It pretty-prints the exact envelope
it sends and the response it gets back. Use `--cwd` / `--socket` to target a specific repo or
socket, and `--file` to feed real plan markdown into the plan gate.

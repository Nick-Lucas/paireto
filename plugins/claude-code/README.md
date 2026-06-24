# tui-companion — Claude Code plugin

This plugin bridges Claude Code to the **TUI Companion** VS Code extension. It runs small,
zero-dependency Node hook scripts that talk to the extension over a per-repo Unix domain socket.

It does two things:

1. **Lifecycle telemetry** (`on-event.js`) — forwards session/tool/worktree events so the
   extension can show repo + agent activity in the status bar. Fire-and-forget; never blocks the agent.
2. **Plan-approval gate** (`on-plan-gate.js`) — on `PermissionRequest`/`ExitPlanMode` it sends the plan
   markdown to VS Code and blocks until you Approve or Send Feedback in the editor. Feedback comes back
   as a `deny` so Claude revises the plan.

The socket lives under `${XDG_STATE_HOME:-~/.local/state}/tui-companion/s/<repo-key>.sock`, where
`<repo-key>` is `sha256(realpath(git-toplevel))[:8]`. The extension creates one socket per open repo;
the hook scripts resolve which socket to use from the agent's `cwd`.

## Install (automatic)

The VS Code extension installs and registers this plugin for you on activation. You normally don't
need to do anything beyond having the extension running.

## Install (manual)

If you prefer not to use the extension's installer, register this directory as a local marketplace:

```
/plugin marketplace add /absolute/path/to/plugins        # the dir containing .claude-plugin/marketplace.json
/plugin install tui-companion@tui-companion
```

Then restart Claude Code so the hooks take effect.

Alternatively, add the hooks straight into `~/.claude/settings.json` by copying the entries from
`hooks/hooks.json` and replacing `${CLAUDE_PLUGIN_ROOT}` with the absolute path to this directory.

## Emulator (manual testing without an agent)

`scripts/emulator.ts` is a zero-dependency CLI that plays the plugin side of the wire protocol, so
you can drive every VS Code flow — telemetry, the plan gate, the code-review round-trip — by hand,
no Claude Code TUI required. It reuses `bridge.js`, so socket resolution is identical to the real
hooks, and runs directly on Node's built-in TypeScript type-stripping (Node ≥ 22.18 / 23.6 — no
compile step). Run it from inside a repo you've opened in VS Code:

```
node scripts/emulator.ts doctor                  # resolve the socket + handshake — start here
node scripts/emulator.ts event PreToolUse --tool Bash   # one fire-and-forget telemetry event
node scripts/emulator.ts plan                    # ExitPlanMode gate; blocks for Approve/Send Feedback
node scripts/emulator.ts review                  # tui_review session; blocks for Send Feedback/Cancel
node scripts/emulator.ts flow                    # a full simulated session lifecycle of events
node scripts/emulator.ts help                    # all commands + options
```

It pretty-prints the exact envelope it sends and the response it gets back. Use `--cwd` / `--socket`
to target a specific repo or socket, and `--file` to feed real plan markdown into the plan gate.

## Failure behavior

The plan gate reads its policy from `${XDG_STATE_HOME:-~/.local/state}/tui-companion/config.json`
(written by the extension). Defaults: if no extension is listening it **allows** the plan (so a
terminal-only workflow isn't blocked); on timeout or a malformed response it **defers to Claude
Code's native plan-approval prompt**. Telemetry hooks always exit 0.

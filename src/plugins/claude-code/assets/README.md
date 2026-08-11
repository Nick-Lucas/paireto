# paireto — Claude Code plugin

This plugin bridges Claude Code to the **Paireto** VS Code extension. It runs small,
zero-dependency Node hook scripts that talk to the extension over a per-repo Unix domain socket.

It does two things:

1. **Lifecycle telemetry** (`on-event.js`) — forwards session/tool/worktree events so the
   extension can show repo + agent activity in the status bar. Fire-and-forget; never blocks the agent.
2. **Plan-approval gate** (`on-plan-gate.js`) — on `PermissionRequest`/`ExitPlanMode` it sends the plan
   markdown to VS Code and blocks until you Approve or Send Feedback in the editor. Feedback comes back
   as a `deny` so Claude revises the plan.

The socket lives under `${XDG_STATE_HOME:-~/.local/state}/paireto/s/<repo-key>.sock`, where
`<repo-key>` is `sha256(realpath(git-toplevel))[:8]`. The extension creates one socket per open repo;
the hook scripts resolve which socket to use from the agent's `cwd`.

## Install (automatic)

The VS Code extension installs and registers this plugin for you on activation. You normally don't
need to do anything beyond having the extension running.

## Install (manual)

If you prefer not to use the extension's installer, register this directory as a local marketplace:

```
/plugin marketplace add /absolute/path/to/plugins        # the dir containing .claude-plugin/marketplace.json
/plugin install paireto@paireto
```

Then restart Claude Code so the hooks take effect.

Alternatively, add the hooks straight into `~/.claude/settings.json` by copying the entries from
`hooks/hooks.json` and replacing `${CLAUDE_PLUGIN_ROOT}` with the absolute path to this directory.

For manual testing of these flows without a running agent, see the bridge emulator in the repo's
`scripts/` directory.

## Failure behavior

The plan gate's failure behavior is fixed: if no extension is listening it **allows** the plan (so a
terminal-only workflow isn't blocked); on timeout or a malformed response it **defers to Claude
Code's native plan-approval prompt**. Telemetry hooks always exit 0.

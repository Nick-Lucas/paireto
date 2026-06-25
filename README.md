# Paireto

**A VS Code companion for terminal-first AI coding agents.**

Paireto brings a terminal-driven AI coding agent (today: [Claude Code](https://claude.com/claude-code))
into the VS Code UI — *without* replacing the terminal. You keep driving the agent in the terminal;
VS Code gives you the visibility and PR-style review surfaces a terminal can't:

- **See connected agents** and what each is doing at a glance.
- **Review and approve/redirect plans** in the editor instead of the terminal.
- **Review code changes PR-style** — diffs + inline comments — and send that feedback straight back
  to the agent.
- **Browse working changes** with native-git-panel ergonomics, any time.
- **Switch repos/worktrees** quickly.

It is *not* a replacement for the agent's TUI, a full Git client, or a GitHub PR replacement. It
captures no telemetry or transcripts and never scrapes the terminal.

---

## Requirements

- **VS Code** 1.120 or newer
- **git**
- A supported terminal agent — see [Agent support](#agent-support)

---

## Installation

Paireto is two halves that talk over a per-repo Unix domain socket:

1. The **VS Code extension** — the UI you interact with.
2. A small **agent-side plugin** — hooks + an MCP server that report the agent's activity and block
   on plan/review gates.

### 1. Install the VS Code extension

Install `paireto.vsix` (from a release or `pnpm package`):

```sh
code --install-extension paireto.vsix
```

Or use **Extensions → … → Install from VSIX** in VS Code.

### 2. Register the agent-side plugin

On first activation the extension **auto-registers** the bundled plugin for you (controlled by
`paireto.plugin.autoInstall`, default on). If auto-registration fails, VS Code shows a prompt with a
**Copy Command** button — run the copied command in a terminal.

The manual fallback for Claude Code is:

```sh
claude plugin marketplace add "<extension>/plugins" --scope user && \
claude plugin install paireto@paireto --scope user
```

### 3. Restart the agent

**Restart Claude Code** so the new hooks and MCP tool load. That's it — open a repo in VS Code, start
the agent in its terminal, and the agent appears in the Paireto sidebar.

---

## Agent support

Paireto's architecture is agent-agnostic: sessions are correlated by **repository directory**, and the
extension talks to a per-repo socket. Any agent can integrate by shipping a plugin that speaks the
bridge protocol (activity hooks + plan/review gates over the socket).

| Agent | Status |
| --- | --- |
| **Claude Code** | ✅ Supported (bundled plugin, auto-registered) |
| Others (e.g. Codex, OpenCode) | 🔜 Planned |

> **Note:** Claude Code is currently the only supported agent, so this guide uses its terminology
> (plans via ExitPlanMode, permission prompts, the `/paireto-review` command). As more agents are
> added, each will get its own setup section here; the in-app workflows below stay the same.

---

## The sidebar at a glance

Open the **Paireto** view from the activity bar. It has collapsible sections:

- **Agents** — every connected agent session **for the current repo/worktree**, with live status
  (idle / thinking / running a tool / awaiting plan / awaiting permission). Rows awaiting a gate show
  which kind and whether it's *active* (foreground) or *pending*. Click a row to bring its pending
  plan/review to the foreground (or focus its terminal).
- **Changed Files** — a native-git-panel-style list of working changes (always available).
- **Plan Review** — appears while a plan is pending.
- **Feedback** — appears during a code-review session, listing your queued comments.

You'll also get:

- A **status bar item**: current repo · branch + agent activity.
- An **activity-bar badge** (the "ticker") on the Paireto icon: a **count of changed files**, like the
  Git tab. (Agent "needs you" cues live on the bell surfaces below, not the badge.)

---

## Workflows

### Get notified when an agent needs you

When one of *this window's* agents finishes a turn, asks a question, or hits a permission/plan prompt,
Paireto flags it: an **orange bell** appears on the agent row, the status bar, the activity-bar badge,
and the repo switcher, and a sound plays once per transition. Clicking the agent clears the marker.

Configure with `paireto.notify.type` (`sound` / `disabled`) and `paireto.notify.sound`.

### Approve or redirect a plan

1. The agent presents a plan → it **opens in VS Code automatically**, the terminal panel hides, and the
   agent blocks waiting for you.
2. Read it. Optionally add line comments (Question / Comment / Problem) — comments are editable and
   deletable.
3. Resolve with one of two actions:
   - **Approve** (green) — the agent proceeds. By default it continues in **auto** mode
     (`paireto.planApprove.mode`).
   - **Send Feedback** (amber) — the agent revises based on your comments.
4. The plan tab auto-closes and the terminal panel returns.

Closing the plan tab while it's still pending prompts you to Approve or Send Feedback.

### Review code, PR-style

- **Comment any time.** Open any diff in the Changed Files section and add an inline comment. The first
  comment auto-starts a review and reveals the **Feedback** section. No need to wait for the agent.
- **Resolved at turn-end.** When the agent finishes a turn in which it changed files, it parks in
  review mode until you act:
  - **Send Feedback** (amber) — delivers your comments; the agent acts on them.
  - **Approve** (green) — the agent finishes with nothing sent.
  - A turn that changed nothing is never delayed, and nothing is ever sent without an explicit
    **Send Feedback**.
- **On demand.** Run `/paireto-review` in the agent to open a blocking review session in VS Code and
  wait for your decision (`Cmd/Ctrl+Enter` submits).

> Plan Review and Code Review share one "gate". Several agents' gates can be pending at once, but only
> one is foreground (occupying the editor) at a time — click an agent in the **Agents** section to flip
> between them.

### Browse and stage changes

The **Changed Files** section works like the native git panel, grouped top-down: **Committed → Staged →
Working Tree**.

- **Compare To** (HEAD, merge-base, default branch, recent refs, or any branch/ref) and the **Flat /
  Tree** layout toggle are inline buttons on the section row.
- Per file: open changes (row click), open file, stage, unstage, discard. Per folder (tree layout) and
  per group: stage/unstage/discard all.
- Diffs are **editable with full LSP** when the file has no change at a lower git layer — your edits
  land in the working tree and the view refreshes on save.

### Switch repo or worktree

Press **`Cmd/Ctrl+Shift+K`** (or click the status bar item) to open the switcher: current window,
worktrees, and recent repos. Each row summarizes that location's agent activity and whether it has an
open window.

- **Enter** opens the selection in a **new window**.
- **`Shift+Enter`** opens it in the **current window**.

---

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Cmd/Ctrl+Shift+K` | Open the repo / worktree switcher |
| `Shift+Enter` | (in switcher) Open selection in the current window |
| `Cmd/Ctrl+Enter` | (in a plan/review comment) Submit |

---

## Settings

All settings live under `paireto.*`:

| Setting | Default | What it does |
| --- | --- | --- |
| `paireto.plugin.autoInstall` | `true` | Auto-register the bundled agent plugin on activation. |
| `paireto.notify.type` | `sound` | How to alert when an agent needs you (`sound` / `disabled`). |
| `paireto.notify.sound` | `Ping` | System-sound name or absolute path, when `notify.type` is `sound`. |
| `paireto.planApprove.mode` | `auto` | Mode the agent enters when you approve a plan (`auto` / `acceptEdits` / `default` / `plan` / `off`). |
| `paireto.debug` | `false` | Log diagnostics to the *Paireto* output channel. |
| `paireto.planGate.onUnavailable` | `fail-open` | Plan-gate behavior when no window is listening. |
| `paireto.planGate.onTimeout` | `fail-visible` | Plan-gate behavior on timeout. |
| `paireto.planGate.onMalformed` | `fail-visible` | Plan-gate behavior on a malformed response. |
| `paireto.planGate.timeoutSeconds` | `345600` | Max seconds the plan gate blocks for a decision. |

---

## Troubleshooting

- **Agent doesn't appear in the sidebar.** Make sure you restarted the agent after installing, and that
  the repo is open in VS Code. Enable `paireto.debug` and check the *Paireto* output channel.
- **Plugin didn't register.** Re-run the manual command from
  [Register the agent-side plugin](#2-register-the-agent-side-plugin), then restart the agent.
- **No sound on notifications.** Confirm `paireto.notify.type` is `sound` and `paireto.notify.sound`
  names a valid system sound or file path.

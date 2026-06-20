# TUI Companion — Product Requirements

## What it is

A VS Code extension + bundled Claude Code plugin that bring terminal-first AI coding (Claude Code in
a terminal) into the VS Code UI — without replacing the TUI. You keep driving the agent in the
terminal; VS Code gives you visibility and PR-style review surfaces.

## Goals

- See connected agents and their activity at a glance.
- Review and approve/redirect plans in the editor instead of the terminal.
- Review code changes PR-style (diffs + inline comments) and send that feedback straight to the agent.
- Browse working changes with native-git-panel ergonomics any time.
- Switch repos/worktrees quickly.

## Non-goals

- Not a replacement for the Claude Code TUI.
- Not a full Git client or GitHub PR replacement.
- No telemetry/transcript capture; no terminal scraping.

---

## Architecture (one line)

VS Code extension ⇄ per-repo Unix domain socket ⇄ Claude Code plugin (hooks + MCP server). Sessions
are correlated by repository directory, not terminal.

---

## Features

### Agents
- Live list of connected Claude sessions for the workspace, with status (idle / thinking / running
  tool / awaiting plan / awaiting permission) and subagent count.
- Status bar item showing current repo · branch + agent activity.
- "Focus Agent" action on each session row.
- Stuck-state safety net: an agent that goes silent after an un-hookable interrupt is auto-cleared.

### Repo / Worktree Switcher
- `Cmd/Ctrl+Shift+K` (or status bar click) opens a picker: current window, worktrees, recent repos.
- Enter opens in a new window; `Shift+Enter` opens in the current window.

### Plan Review
- When the agent finishes a plan (ExitPlanMode), the plan opens in VS Code automatically and the
  agent blocks waiting for a decision.
- Add line comments tagged Question / Comment / Problem.
- Approve → agent proceeds. Send Feedback → agent gets the comments and revises (deny-with-feedback).

### Code Review (`/tui-review`)
- Run `/tui-review` in the agent; it opens a blocking review session in VS Code and waits.
- Review the diffs, add inline comments (Question / Comment / Problem; `Cmd+Enter` submits).
- Send Feedback → comments returned to the agent, which acts on them immediately. Cancel → agent
  proceeds with no changes. Export → save the review to `.vscode/agent-reviews/`.

### Changes View (always available)
- Native-git-panel-style list of working changes, grouped: **Staged**, **Unstaged**, **Committed**.
  - Committed = files changed since the Compare-To point that aren't already staged/unstaged.
  - Each group title row shows a muted `+adds -dels` line-count indicator after the label, plus a
    colored far-right file-count badge (green=staged / orange=unstaged / blue=committed).
- **Compare To** presets: HEAD, merge-base, default branch (main/master auto-detected), recent refs,
  or any branch/ref via picker.
- **Flat / Tree** layout toggle.
- Per-file: open changes (row click), open file (first inline button on every row), stage, unstage,
  discard (confirm) + right-click menu.
- Browsing diffs are **editable with full LSP** when the file has no change at a lower level
  (committed > staged > unstaged): the modified side is the real working-tree file, so edits land in
  the unstaged level and the view refreshes on save. The first edit to a staged/committed file's
  diff flips it straight to the unstaged diff (index → live working tree), preserving caret + focus.
  Diffs stay read-only during a `/tui-review`
  session (so inline comments work) and for deleted files.
- Per-folder (tree layout): stage / unstage / discard every change under the folder, via the same
  inline buttons — matching the native git panel.
- Group-level: Stage All, Unstage All, Discard All.
- Git controls apply to Staged/Unstaged; the Committed group is read-only.

### Sidebar
- One "TUI Companion" view with collapsible sections: Agents, Changed Files (always), Plan Review
  (while a plan is pending), Feedback (during a review session). Section controls live in the title bar.

---

## Core workflows

**Plan approval**
1. Agent presents a plan → it opens in VS Code, agent waits.
2. You read it, optionally comment.
3. Approve (agent continues) or Send Feedback (agent revises).

**Code review**
1. You/agent: run `/tui-review`.
2. VS Code reveals the review; you comment on the diffs.
3. Send Feedback (agent applies) or Cancel.

**Browse changes**
1. Open the Changes section any time.
2. Pick a Compare-To point; switch flat/tree.
3. Stage / unstage / discard / open diffs like the native git panel.

**Switch context**
1. `Cmd/Ctrl+Shift+K`.
2. Pick a worktree or recent repo; open in this or a new window.

---

## Setup

- Install the VS Code extension; it auto-registers the bundled Claude Code plugin (manual fallback
  available).
- Restart Claude Code so hooks + the MCP tool load.
- Requires: VS Code, Claude Code, git.

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
- Live list of connected Claude sessions **for the current repo/worktree**, with status (idle /
  thinking / running tool / awaiting plan / awaiting permission) and subagent count. Rows awaiting a
  gate show which kind (plan/code review) and whether it's foreground (active) or pending.
- Status bar item showing current repo · branch + agent activity.
- Clicking an agent row switches its pending plan/review to the foreground (or focuses the terminal
  if it has none); a "Focus Agent" button focuses the terminal directly.
- Stuck-state safety net: an agent that goes silent after an un-hookable interrupt is auto-cleared;
  an agent whose process is killed (no SessionEnd hook fires) is detected via a liveness connection
  the plugin's MCP server holds open, and dropped from the list immediately.

### Repo / Worktree Switcher
- `Cmd/Ctrl+Shift+K` (or status bar click) opens a picker: current window, worktrees, recent repos.
- Enter opens in a new window; `Shift+Enter` opens in the current window.

### Plan & Code Review (shared gate)
Plan Review and Code Review are two surfaces over one shared "gate". Several agents' gates can be
**pending at once**, but only **one is foreground** (occupying the editor/comment surfaces) at a
time — the others wait, unresolved, until brought forward. Both gather kinded line comments, and both
resolve with the same two actions.
- **Two actions (colored icons):** **Approve** (green) → agent proceeds; **Send Feedback** (amber) →
  deny-with-feedback (plan: agent revises; review: agent acts on the comments). No Reject — Send
  Feedback covers it.
- Line comments tagged Question / Comment / Problem; **comments are editable and deletable** after
  creation (edit/save/delete on the comment).
- **Switch between agents:** the Agents section is scoped to the current repo/worktree and shows
  which agents are awaiting which gate (plan vs review) and which is foreground vs pending. Clicking
  an agent brings its gate to the foreground (backgrounding the current one without resolving it), so
  you can flip between several pending plans/reviews and come back. At most one review is pending at a
  time; multiple plans can be.
- **Disconnect resets state:** if the agent side ends another way (interrupt, crash, ExitPlanMode
  resolved in the terminal), the dropped connection auto-closes the plan/review and resets the UI.
- **Bottom panel:** hidden while any gate (plan or review) is foreground, restored once none is.

### Plan Review
- When the agent finishes a plan (ExitPlanMode), the plan opens in VS Code automatically, the bottom
  panel (terminal) is hidden, and the agent blocks waiting for a decision.
- On any resolution the plan tab auto-closes and the terminal panel is restored.
- Closing the plan tab while it's still pending prompts you to Approve or Send Feedback (dismiss to
  keep reviewing).

### Code Review (`/tui-review`)
- Run `/tui-review` in the agent; it opens a blocking review session in VS Code and waits.
- Review the diffs, add/edit inline comments (Question / Comment / Problem; `Cmd+Enter` submits).
- Send Feedback → comments returned to the agent, which acts on them immediately. Approve → agent
  proceeds with no changes.

### Changes View (always available)
- Native-git-panel-style list of working changes, grouped top-down by git layer: **Committed**,
  **Staged**, **Working Tree**.
  - Committed = files changed since the Compare-To point that aren't already staged/unstaged.
  - Each group title row shows a muted `N files · +adds -dels` indicator after the label.
- **Compare To** presets (HEAD, merge-base, default branch (main/master auto-detected), recent refs,
  or any branch/ref via picker) and the **Flat / Tree** layout toggle are inline buttons on the
  Changed Files section row.
- Per-file: open changes (row click), open file (first inline button on every row), stage, unstage,
  discard (confirm) + right-click menu.
- Browsing diffs are **editable with full LSP** when the file has no change at a lower level
  (committed > staged > unstaged): the modified side is the real working-tree file, so edits land in
  the unstaged level and the view refreshes on save. The first edit to a staged/committed file's
  diff re-targets it in place to the unstaged diff (index → live working tree) — same tab, no save
  prompt, caret + focus preserved. Diffs stay read-only during a `/tui-review`
  session (so inline comments work) and for deleted files.
- Per-folder (tree layout): stage / unstage / discard every change under the folder, via the same
  inline buttons — matching the native git panel.
- The tree selection follows the diff in focus: opening a file or switching between open diff tabs
  selects its row, and when an edit demotes a staged/committed diff to the working tree, the Unstaged
  row is highlighted as it appears.
- Group-level: Stage All, Unstage All, Discard All.
- Git controls apply to Staged/Unstaged; the Committed group is read-only.

### Sidebar
- One "TUI Companion" view with collapsible sections: Agents, Changed Files (always), Plan Review
  (while a plan is pending), Feedback (during a review session). Section controls live on their
  section rows / the title bar; the shared Approve (green) and Send Feedback (amber) gate actions use
  colored icons and appear whenever a plan or review is active.

---

## Core workflows

**Plan approval**
1. Agent presents a plan → it opens in VS Code (terminal panel hidden), agent waits.
2. You read it, optionally comment (comments are editable).
3. Approve (agent continues) or Send Feedback (agent revises). The tab auto-closes and the terminal
   returns.

**Code review**
1. You/agent: run `/tui-review`.
2. VS Code reveals the review; you comment on the diffs.
3. Send Feedback (agent applies) or Approve (agent proceeds with no changes).

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

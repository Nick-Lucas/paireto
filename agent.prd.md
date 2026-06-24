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
- Each row is labelled by its short session id, so agents in one repo are distinguishable; the repo,
  start time, and current/last tool are in the tooltip.
- Status bar item showing current repo · branch + agent activity.
- Clicking an agent row switches its pending plan/review to the foreground (or focuses the terminal
  if it has none); a "Focus Agent" button focuses the terminal directly. Clicking also clears the
  row's "needs you" marker.
- **Needs-you alert:** when an agent enters a state that wants the user — finished a turn (Stop),
  awaiting permission, or awaiting plan approval — an orange bell appears on the agent row (and in the
  status bar + repo switcher), and once per transition a sound plays (`tui-companion.notify.type` =
  `sound` (default, sound from `tui-companion.notify.sound`) or `disabled`). Only this window's agents
  alert.
- Stuck-state safety net: an agent that goes silent after an un-hookable interrupt is auto-cleared;
  an agent whose process is killed (no SessionEnd hook fires) is detected via a liveness connection
  the plugin's MCP server holds open, and dropped from the list immediately.

### Repo / Worktree Switcher
- `Cmd/Ctrl+Shift+K` (or status bar click) opens a picker: current window, worktrees, recent repos.
- Enter opens in a new window; `Shift+Enter` opens in the current window.
- Each row summarises that location's agent activity and whether it has an open window: `no window`,
  `open · idle`, a live state (`thinking · 2 agents`, `plan review`, …), or `needs you`. The data
  comes from per-repo activity files each window publishes (there's no cross-window VS Code API).

### Plan & Code Review (shared gate)
Plan Review and Code Review are two surfaces over one shared "gate". Several agents' gates can be
**pending at once**, but only **one is foreground** (occupying the editor/comment surfaces) at a
time — the others wait, unresolved, until brought forward. Both gather kinded line comments, and both
resolve with the same two actions.
- **Two actions (colored icons):** **Approve** (green) → agent proceeds; **Send Feedback** (amber) →
  deny-with-feedback (plan: agent revises; review: agent acts on the comments). No Reject — Send
  Feedback covers it. Only the relevant one shows: **Approve** until any feedback is queued, then
  **Send Feedback**.
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
- Approving puts the agent into **auto** mode by default so it proceeds without re-prompting
  (`tui-companion.planApprove.mode` — `auto` / `acceptEdits` / `default` / `plan` / `off`).

### Code Review
- **Comment any time:** open any Changes-section diff and add inline comments (Question / Comment /
  Problem) without starting anything — the first comment auto-starts a review and reveals the Feedback
  section. Commenting works whether or not the diff is editable; editability is purely structural
  (editable when the file has no lower-level change, locked otherwise) and a review never changes it.
- **Resolved at turn-end:** when the agent finishes a turn in which it changed files (or there are
  uncommitted changes), it parks in review mode until you act — **Send Feedback** delivers your
  comments, **Approve** lets it finish with nothing sent. Nothing is ever sent without an explicit
  Send Feedback; a turn that changed nothing is never delayed.
- **Manual `/tui-review`:** still available — opens a blocking review session in VS Code and waits;
  Send Feedback returns the comments, Approve proceeds with no changes (`Cmd+Enter` submits).

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
  section rows / the title bar; the shared gate actions use colored icons whenever a plan or review is
  active — **Approve** (green) until feedback is queued, then **Send Feedback** (amber).

---

## Core workflows

**Plan approval**
1. Agent presents a plan → it opens in VS Code (terminal panel hidden), agent waits.
2. You read it, optionally comment (comments are editable).
3. Approve (agent continues, in auto mode by default) or Send Feedback (agent revises). The tab
   auto-closes and the terminal returns.

**Code review**
1. Comment on the diffs whenever you like (the first comment starts a review), or run `/tui-review`
   for a blocking session on demand.
2. When the agent finishes a turn that changed files, it parks in review mode until you act.
3. Send Feedback (agent applies the comments) or Approve (agent proceeds with no changes).

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

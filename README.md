<p align="center">
  <img src="media/Paireto%20Header@2x.png" alt="Paireto" width="420" />
</p>

> When agents write 80% of your code in 20% of the time, engineering becomes 80% judgment.

Paireto brings pair-programing to your TUI coding agents in VS Code: planning, review, editing, and worktree management, in one engineer-grade workflow.

# Contents

- [Why I Built Paireto](#why-i-built-paireto)
- [Installation](#installation)
  - [1. Install the VS Code extension](#1-install-the-vs-code-extension)
  - [2. Install the agent plugin](#2-install-the-agent-plugin)
  - [3. Restart the agent](#3-restart-the-agent)
- [Agent support](#agent-support)
- [The sidebar at a glance](#the-sidebar-at-a-glance)
- [Workflows](#workflows)
  - [Get notified when an agent needs you](#get-notified-when-an-agent-needs-you)
  - [Approve or redirect a plan](#approve-or-redirect-a-plan)
  - [Review code, PR-style](#review-code-pr-style)
  - [Browse and stage changes](#browse-and-stage-changes)
  - [Switch repo or worktree](#switch-repo-or-worktree)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Troubleshooting](#troubleshooting)

# Why I Built Paireto

Agentic coding changed software over-night. But for high-craft engineering, the direction between tools and the reality of engineering work keeps widening.

I’m an engineer working with engineers. My code still has to meet a human standard. I don’t need a vibe-coding tool.

I tried the Conductor immitators, with worktrees, git diffs, and agent sessions alongside my editor. They were useful, but high-friction. The moment I needed LSP feedback, linter errors, or a quick manual edit, I was back in VS Code. They were a second app with weaker versions of feature my editor already had.

I tried GUI agents, but they pulled me toward more mouse-driven workflows or a new editor ecosystem.

I tried TUI agents, and loved the ease they integrated with my editor workflows, but they struggle with structured planning, review, editor integration, and human reading comprehension.

I increasingly found myself editing code from Git Diff tabs, so I can track what the agent has changed and refine it. But had no way to prepare agent feedback easily.

I tried Plannotator, and it clicked: planning and review are the missing pieces in my workflow. But I still had to jump between windows, and work outside my editor during code review and editing.

I didn't need a second app, I needed a tighter integration between my TUI and editor. So I built this...

# Installation

Paireto comes in two parts:

1. The **VS Code extension**
2. An agent-harness integration

## 1. Install the VS Code extension

### From VS Code Marketplace

> TODO: add marketplace link

### From a Release / Source

Install `paireto.vsix` (from a release or `pnpm package`):

```sh
# 1. Download from GitHub Releases and install
# 2. VS Code: Extensions → … → Install from VSIX

# OR

# 1. Download from GitHub Releases
# 2. From CLI:
code --install-extension paireto.vsix
```


## 2. Install the agent plugin

### Automatic Agent setup

On first activation the Paireto **auto-registers** the bundled plugin for you (controlled by
`paireto.plugin.autoInstall`, default on). If auto-registration fails, VS Code shows a prompt with a
**Copy Command** button — run the copied command in a terminal.

### Manual setup for Claude Code:

```sh
claude plugin marketplace add "<extension>/plugins" --scope user && \
claude plugin install paireto@paireto --scope user
```

## 3. Restart the agent

**Restart your agent** to load the Paireto integration. That's it — open a repo in VS Code, start
the agent in its terminal, and the agent appears in the Paireto sidebar.

---

# Agent support

Paireto's architecture is agent-agnostic, but still in development. We currently support

| Agent | Status |
| --- | --- |
| **Claude Code** | ✅ Supported (bundled plugin, auto-installed) |
| Codex TUI | 🔜 Planned |
| OpenCode TUI | 🔜 Planned |
| Pi TUI | 🔜 Planned |
| Others? | ＃ Open an Issue |


---

# The sidebar at a glance

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

# Workflows

## Get notified when an agent needs you

When one of *this window's* agents finishes a turn, asks a question, or hits a permission/plan prompt,
Paireto flags it: an **orange bell** appears on the agent row, the status bar, the activity-bar badge,
and the repo switcher, and a sound plays once per transition. Clicking the agent clears the marker.

Configure with `paireto.notify.type` (`sound` / `disabled`) and `paireto.notify.sound`.

## Approve or redirect a plan

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

## Review code, PR-style

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

## Browse and stage changes

The **Changed Files** section works like the native git panel, grouped top-down: **Committed → Staged →
Working Tree**.

- **Compare To** (HEAD, merge-base, default branch, recent refs, or any branch/ref) and the **Flat /
  Tree** layout toggle are inline buttons on the section row.
- Per file: open changes (row click), open file, stage, unstage, discard. Per folder (tree layout) and
  per group: stage/unstage/discard all.
- Diffs are **editable with full LSP** when the file has no change at a lower git layer — your edits
  land in the working tree and the view refreshes on save.

## Switch repo or worktree

Press **`Cmd/Ctrl+Shift+K`** (or click the status bar item) to open the switcher: current window,
worktrees, and recent repos. Each row summarizes that location's agent activity and whether it has an
open window.

- **Enter** opens the selection in a **new window**.
- **`Shift+Enter`** opens it in the **current window**.

---

# Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Cmd/Ctrl+Shift+K` | Open the repo / worktree switcher |
| `Shift+Enter` | (in switcher) Open selection in the current window |
| `Cmd/Ctrl+Enter` | (in a plan/review comment) Submit |

---

# Troubleshooting

- **Agent doesn't appear in the sidebar.** Make sure you restarted the agent after installing, and that
  the repo is open in VS Code. Enable `paireto.debug` and check the *Paireto* output channel.
- **Plugin didn't register.** Re-run the manual command from
  [Register the agent-side plugin](#2-register-the-agent-side-plugin), then restart the agent.
- **No sound on notifications.** Confirm `paireto.notify.type` is `sound` and `paireto.notify.sound`
  names a valid system sound or file path.

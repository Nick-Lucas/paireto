<p align="center">
  <img src="media/PairetoHeader2x.png" alt="Paireto" width="420" />
</p>

> "When agents write 80% of your code in 20% of the time, engineering is 80% judgment" - Paireto (the Parrot)

Paireto brings pair-programming to your TUI coding agents in VS Code: planning, review, editing, and worktree management, in one engineer-grade workflow.

# Contents

- [Contents](#contents)
- [Why I Built Paireto](#why-i-built-paireto)
- [Features at a glance](#features-at-a-glance)
- [Installation](#installation)
    - [Agent harness setup](#agent-harness-setup)
- [Agent support](#agent-support)
- [Workflows](#workflows)
  - [Plan Mode](#plan-mode)
  - [Review Mode](#review-mode)
  - [Guided Review](#guided-review)
  - [Changed Files view](#changed-files-view)
  - [Switch repo or worktree](#switch-repo-or-worktree)
- [Troubleshooting](#troubleshooting)

# Why I Built Paireto

Agentic coding changed software over-night. But for high-craft engineering, the direction between tools and the reality of engineering work keeps widening.

I’m an engineer working with engineers. My code still has to meet a human standard. I don’t need a vibe-coding tool.

I tried the Conductor immitators, with worktrees, git diffs, and agent sessions alongside my editor. They were useful, but high-friction. The moment I needed LSP feedback, linter errors, or a quick manual edit, I was back in VS Code. They were a second app with weaker versions of features my editor already had.

I tried GUI agents, but they pulled me toward more mouse-driven workflows or a new editor ecosystem.

I tried TUI agents, and loved the ease they integrated with my editor workflows, but they struggle with structured planning, review, editor integration, and human reading comprehension.

I increasingly found myself editing code from Git Diff tabs, so I could track what the agent had changed and refine. But had no way to prepare agent feedback easily.

I tried Plannotator, and it clicked: planning and review are two missing pieces in my workflow. But I still had to jump between apps, and work outside my editor during code review, losing LSP features which I depend on to understand code.

I didn't need a second app, I needed a tighter integration between my TUI and editor. So I built this...

# Features at a glance

| Feature | What it does |
| --- | --- |
| 🤖 **Agent status** | Live status and notifications from your agent |
| 👩🏽‍💻 **Changed Filers** | Edit from git diffs and compare to any git ref |
| 📋 **Plan review** | Feed back on agent plans before implementation |
| 🔍 **Code review** | Review completed agent code before accepting it |
| 🧭 **Guided review** | Your agent groups a branch's changes into described changesets to read in order |
| 🗂️ **Repository & Worktree** | Management and switching, with multi-repo agent visiblity |
| 🚀 **More to come** | See [TODO.md](./TODO.md) |

# Installation

Paireto comes in two parts:

1. The [**VS Code extension**](https://marketplace.visualstudio.com/items?itemName=Paireto.paireto)
2. An agent-harness integration

### Agent harness setup

On first install a **Welcome** wizard will take you through setup of your agents. You can return to
this screen at any time from the Command Palette by opening `Paireto: Open Welcome`.

After plugin setup, **restart your agent** to load the Paireto integration. Open a repo in VS Code, start the agent in its terminal, and the agent appears in the Paireto sidebar.

# Agent support

Paireto's architecture is agent-agnostic, but still in development. We currently support

| Agent | Status |
| --- | --- |
| **Claude Code** | ✅ Supported |
| **Codex TUI** | ✅ Supported |
| **Kiro CLI v3** | ✅ Supported (V3+ only) |
| **OpenCode TUI** | ✅ Supported |
| Pi TUI | 🔜 Planned |
| Others? | ＃ Open an Issue |

# Workflows

## Plan Mode

When your agent finishes planning, the plan opens in VS Code and the agent waits. You may leave inline
comments from the VS Code editor, then click **Approve** or **Send Feedback** to instruct the agent

## Review Mode

When your agent tries to end its turn with any changes made, a review is (by default) started automatically. You can also start a review at any time with the `/paireto:review` skill.

Diffs are fully functional editors with LSPs and linters working as normal. Add inline comment from VS Code edit or diff tabs. Click **Send Feedback** to hand over your comments, or **Approve** to let the agent finish. 

## Guided Review

Ask your agent for a guided review (`/paireto:guided-review`, `$paireto-guided-review`, or
`/paireto-guided-review`) and it studies the changes, then hands VS Code a **review plan**: the changed
files grouped into named changesets, each with a description and its files in the order you should read
them.

A **Review Plan** section replaces the Changed Files list while it is open. Work through it changeset by
changeset: click a changeset to read a description of what it does, click a file to open its diff, and
stage or unstage a whole changeset from its row. Each file row shows which git layer it sits in
(committed, staged, or working tree). Anything the plan did not name is collected under **Other
changes**, so nothing is hidden.

Comment on a file diff as usual, or on a changeset's description to give feedback on the grouping
itself. Finish with the usual **Approve** or **Send Feedback**.

## Changed Files view

**Changed Files** is the native git panel with extras: pick what to **Compare To** (HEAD, merge-base, stack-base, default branch, or any other ref), add review comments for your agent, and step in manually to fix code. 

## Switch repo or worktree

Hit **`Cmd+Shift+K`** for the switcher: current window, worktrees, and recent repos, each showing
its agent activity. Manage all your VS Code windows and worktrees from any other window.


# Troubleshooting

- **Agent doesn't appear in the sidebar.** Make sure you restarted the agent after installing, and that
  the repo is open in VS Code. Set `paireto.logLevel` to `debug` and check the *Paireto* output channel.
- **Plugin didn't register.** Open `Paireto: Open Welcome`, run setup again, then restart the agent.
- **No sound on notifications.** Confirm `paireto.notify.type` is `sound` and `paireto.notify.sound`
  names a valid system sound or file path.

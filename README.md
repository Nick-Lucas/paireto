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
| 🗂️ **Repository & Worktree** | Management and switching, with multi-repo agent visiblity |
| 🚀 **More to come** | See [TODO.md](./TODO.md) |

# Installation

Paireto comes in two parts:

1. The [**VS Code extension**](https://marketplace.visualstudio.com/items?itemName=Paireto.paireto)
2. An agent-harness integration

### Agent harness setup

On first install a **Welcome** wizard will take you through setup of your agents, you can return to this screen as any time via the Command Palette by opening `Paireto: Open Welcome`

After plugin setup, **Restart your agent** to load the Paireto integration. That's it — open a repo in VS Code, start
the agent in its terminal, and the agent appears in the Paireto sidebar.


# Agent support

Paireto's architecture is agent-agnostic, but still in development. We currently support

| Agent | Status |
| --- | --- |
| **Claude Code** | ✅ Supported (bundled plugin, set up from the Welcome screen) |
| Codex TUI | 🔜 Planned |
| OpenCode TUI | 🔜 Planned |
| Pi TUI | 🔜 Planned |
| Others? | ＃ Open an Issue |


# Workflows

## Plan Mode

When your agent finishes planning, the plan opens in VS Code and the agent waits. You may leave inline
comments from the VS Code editor, then click **Approve** or **Send Feedback** to instruct the agent

## Review Mode

When your agent tries to end its turn with any changes made, a review is (by default) started automatically. You can also start a review at any time with the `/paireto:paireto-review` skill.

Diffs are fully functional editors with LSPs and linters working as normal. Add inline comment from VS Code edit or diff tabs. Click **Send Feedback** to hand over your comments, or **Approve** to let the agent finish. 

## Changed Files view

**Changed Files** is the native git panel with extras: pick what to **Compare To** (HEAD, merge-base, default branch, or any other ref), add review comments for your agent, and step in manually to fix code. 

## Switch repo or worktree

Hit **`Cmd+Shift+K`** for the switcher: current window, worktrees, and recent repos, each showing
its agent activity. Manage all your VS Code windows and worktrees from any other window.


# Troubleshooting

- **Agent doesn't appear in the sidebar.** Make sure you restarted the agent after installing, and that
  the repo is open in VS Code. Set `paireto.logLevel` to `debug` and check the *Paireto* output channel.
- **Plugin didn't register.** Re-run the manual command from
  [Register the agent-side plugin](#2-register-the-agent-side-plugin), then restart the agent.
- **No sound on notifications.** Confirm `paireto.notify.type` is `sound` and `paireto.notify.sound`
  names a valid system sound or file path.

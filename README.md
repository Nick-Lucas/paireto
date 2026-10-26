<p align="center">
  <img src="media/PairetoHeader2x.png" alt="Paireto" width="420" />
</p>

> "Agents do 80% of the work; what's left to us is understanding, judgement, and coherence" - Paireto (the Parrot)

<div align="center">
<br/>
  <a href="https://github.com/Nick-Lucas/paireto/actions/workflows/ci.yml">
    <img alt="CI" src="https://github.com/Nick-Lucas/paireto/actions/workflows/ci.yml/badge.svg?branch=main" />
  </a>
  <a href="https://marketplace.visualstudio.com/items?itemName=Paireto.paireto">
    <img alt="VS Code Marketplace version" src="https://vsmarketplacebadges.dev/version/Paireto.paireto.svg?label=VS%20Code%20Marketplace" />
  </a>
  <a href="https://open-vsx.org/extension/Paireto/paireto">
    <img alt="Open VSX version" src="https://img.shields.io/open-vsx/v/Paireto/paireto?label=Open%20VSX" />
  </a>
  
  <h4>Pair-programming for your TUI coding agents in VS Code.<br />Planning, review, editing, and worktree management, in one engineer-grade workflow.</h4>
</div>

<br />

[![Launch Video](https://github.com/user-attachments/assets/f78450d7-caba-42cb-b248-82e7f18e6df5)](https://github.com/user-attachments/assets/f78450d7-caba-42cb-b248-82e7f18e6df5)

---

- [Why Paireto?](#why-paireto)
- [Features at a glance](#features-at-a-glance)
- [Installation](#installation)
    - [Agent harness setup](#agent-harness-setup)
    - [Keyboard Shortcuts](#keyboard-shortcuts)
- [Agent support](#agent-support)
- [Workflows](#workflows)
  - [Plan Review](#plan-review)
  - [Code Review](#code-review)
  - [Changed Files view](#changed-files-view)
  - [Switch repo or worktree](#switch-repo-or-worktree)
- [Skills](#skills)
  - [`/paireto:review`](#pairetoreview)
  - [`/paireto:guided-review [optional-guidance]`](#pairetoguided-review-optional-guidance)
  - [`/paireto-plan <prompt>` (Pi only)](#paireto-plan-prompt-pi-only)
- [Troubleshooting](#troubleshooting)

# Why Paireto?

Agentic coding changed software overnight. But for high-craft engineering, the gap between agentic tools and the reality of engineering work keeps widening. [Agents create decoherent systems](https://maevyn.codes/decoherence) over time when not properly guided, and complex systems still require human understanding and real engineering standards.

We have ADEs, Agent GUIs, TUIs, and plugins like Plannotator. There are a lot of good ideas out there, but jumping between apps just to get an inferior version of tools an editor already has is cumbersome: for example, diffs without LSP features, or without the editing that IDEs were built to provide for exploration and quick iteration.

I didn't need a second app, I needed a tighter integration between my agent and editor. So I built this...

# Features at a glance

| Feature | What it does |
| --- | --- |
| 🤖 **Agent status** | Live status and notifications from your agent |
| 👩🏽‍💻 **Changed Files** | Edit from any git comparison, in multiple view modes |
| 📋 **Plan review** | Give feedback on agent plans before implementation |
| 🔍 **Code review** | Review completed agent code before accepting it |
| 🧭 **Guided review** | Your agent groups a branch's changes into described changesets to read in order |
| 🗂️ **Repository & Worktree** | Management and switching, with multi-repo agent visibility |

# Installation

Paireto comes in two parts:

1. The **VS Code extension**, from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=Paireto.paireto) or [Open VSX](https://open-vsx.org/extension/Paireto/paireto)
2. Agent plugins (focused on TUI agents)

### Agent harness setup

On first install, a **Welcome** wizard takes you through the setup of your agents. You can return to this screen at any time from the Command Palette by opening `Paireto: Open Welcome`.

After plugin setup, **restart your agent** to load the Paireto integration. Open a repo in VS Code, start the agent in its terminal, and the agent appears in the Paireto sidebar.

### Keyboard Shortcuts

The Welcome screen also recommends keyboard shortcuts for common actions. Not all of them are Paireto actions, but they include shortcuts that VS Code does not map by default:

| Action | Shortcut |
| --- | --- |
| Open Welcome | `Cmd+Shift+P` → `Paireto: Open Welcome` |
| Focus Paireto | `Cmd+Shift+C` |
| Worktree Switcher | `Cmd+Shift+K` |
| Focus terminal | `Cmd+'` |
| Toggle bottom bar | `Cmd+J` |
| Toggle fullscreen terminal | `Cmd+Shift+=` |
| Previous terminal tab | `Cmd+Shift+[` |
| Next terminal tab | `Cmd+Shift+]` |
| Quick-launch a TUI agent with a terminal profile | ``Ctrl+Shift+` `` |

# Agent support

Paireto's architecture is agent-agnostic, but currently focused on agent TUIs. We support:

| Agent | Status |
| --- | --- |
| **Claude Code** | ✅ Supported |
| **Codex TUI** | ✅ Supported |
| **Kiro CLI v3** | ✅ Supported (v3+ only) |
| **OpenCode TUI** | ✅ Supported |
| **Pi** | ✅ Supported |
| Others? | ❗️ Open an Issue |

# Workflows

## Plan Review

When your agent finishes planning, the plan opens in Paireto. You can leave inline comments from the VS Code editor, then click **Approve** or **Send Feedback** to instruct the agent. When the revision comes back, you'll get a diff so you only need to re-read what actually changed.

**Pi has no plan mode of its own, so Paireto adds one.** To use it, start with [`/paireto-plan`](#paireto-plan-prompt-pi-only).

## Code Review

By default, when your agent tries to end its turn after making changes, a review starts automatically. You can also start one at any time with the [`/paireto:review`](#pairetoreview) skill. (Note: on Kiro, reviews do not start automatically because of harness limitations.)

Diffs are fully functional editors with LSPs and linters working as normal. Add inline comments from VS Code editor or diff tabs. Click **Send Feedback** to hand over your comments, or **Approve** to let the agent finish.

## Changed Files view

**Changed Files** is like the native git panel, but on steroids: pick what to **Compare To**, add review comments for your agent, and step in manually to fix code. You can even use it on other people's PRs to leave feedback via the GitHub extension.

The **Compare To** button lets you choose any git ref to compare against: HEAD, merge-base, stack-base, default branch, or a ref of your choosing.

Use the **View Modes** button to pick one of three views or toggle between a tree and a flat layout.

- **Staging** groups the changes into Committed, Staged and Working Tree, similar to the native git panel.
- **Delta** shows each file once, with its net change against Compare To. You can stage and unstage files without them moving around.
- **Review** shows the same rows with a checkbox. Tick a file when you've read it. This is useful when you review changes that are already committed.

## Switch repo or worktree

Hit **`Cmd+Shift+K`** to view all your worktrees and their agent state. You can switch to another open window or replace your current window with a different worktree.

# Skills

The Paireto plugin adds these skills and commands to your agent. These docs cover the Claude Code format since other harnesses use their own syntax, for example: 

- **Claude Code, OpenCode, Kiro:** `/paireto-review`
- **Codex:** `$paireto-review`
- **Pi:** `/skill:paireto-review`

## `/paireto:review`

Start a [Review](#review-mode) at any time with this skill. Use it to pick up comments you've left outside of review mode or start an ad-hoc review.

With Kiro, reviews do not start automatically so you need to use this skill to initiate them manually.

## `/paireto:guided-review [optional-guidance]`

Ask your agent for a **Guided Review** with this skill. It studies the changes, then populates the Changed Files list with a structured review plan that guides you through the changes in a more linear and organized manner.

Comment on a file diff, or on a changeset's body to give feedback on the overall implementation. Finish with the usual **Approve** or **Send Feedback**.

## `/paireto-plan <prompt>` (Pi only)

Start a planning turn in Pi. Pi has no plan mode of its own, so this command adds one. The `write` and `edit` tools stay blocked until you approve the plan. When the plan is ready, it opens in Paireto for [Plan Review](#plan-mode).

# Troubleshooting

- **Agent doesn't appear in the sidebar.** Make sure you restarted the agent after installing, and that the repo is open in VS Code. Set `paireto.logLevel` to `debug` and check the *Paireto* output channel.
- **Plugin didn't register.** Open `Paireto: Open Welcome`, run setup again, then restart the agent.
- **No sound on notifications.** Confirm `paireto.notify.type` is `sound` and `paireto.notify.sound` names a valid system sound or file path.

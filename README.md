<p align="center">
  <img src="media/PairetoHeader2x.png" alt="Paireto" width="420" />
</p>

> "Agents do 80% of the work, what's left to us is understanding, judgement, and coherence" - Paireto (the Parrot)

Paireto brings pair-programming to your TUI coding agents in VS Code: planning, review, editing, and worktree management, in one engineer-grade workflow.

[![Launch Video](https://private-user-images.githubusercontent.com/8896153/684046614-046b7b83-9afd-417e-8565-0005a6c16910.mp4?jwt=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJnaXRodWIuY29tIiwiYXVkIjoicmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbSIsImtleSI6ImtleTUiLCJleHAiOjE3OTI5MzQwMDIsIm5iZiI6MTc5MjkzMzcwMiwicGF0aCI6Ii84ODk2MTUzLzY4NDA0NjYxNC0wNDZiN2I4My05YWZkLTQxN2UtODU2NS0wMDA1YTZjMTY5MTAubXA0P1gtQW16LUFsZ29yaXRobT1BV1M0LUhNQUMtU0hBMjU2JlgtQW16LUNyZWRlbnRpYWw9QUtJQVZDT0RZTFNBNTNQUUs0WkElMkYyMDI2MTAyNSUyRnVzLWVhc3QtMSUyRnMzJTJGYXdzNF9yZXF1ZXN0JlgtQW16LURhdGU9MjAyNjEwMjVUMTMwODIyWiZYLUFtei1FeHBpcmVzPTMwMCZYLUFtei1TaWduYXR1cmU9YTViMjA4MGJlZTQ0YjIzMTg3YjFiMzVhOTIyMmFhY2UwZDBiOTgwM2NiZTA0NDkxMjlkNjg2MTFjYzNjNjQyZSZYLUFtei1TaWduZWRIZWFkZXJzPWhvc3QmcmVzcG9uc2UtY29udGVudC10eXBlPXZpZGVvJTJGbXA0In0.8NXZRTevc3z4rr6W18lRkJ3DzYxgY83WLJBT_Ct6SW0)](https://private-user-images.githubusercontent.com/8896153/684046614-046b7b83-9afd-417e-8565-0005a6c16910.mp4?jwt=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJnaXRodWIuY29tIiwiYXVkIjoicmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbSIsImtleSI6ImtleTUiLCJleHAiOjE3OTI5MzQwMDIsIm5iZiI6MTc5MjkzMzcwMiwicGF0aCI6Ii84ODk2MTUzLzY4NDA0NjYxNC0wNDZiN2I4My05YWZkLTQxN2UtODU2NS0wMDA1YTZjMTY5MTAubXA0P1gtQW16LUFsZ29yaXRobT1BV1M0LUhNQUMtU0hBMjU2JlgtQW16LUNyZWRlbnRpYWw9QUtJQVZDT0RZTFNBNTNQUUs0WkElMkYyMDI2MTAyNSUyRnVzLWVhc3QtMSUyRnMzJTJGYXdzNF9yZXF1ZXN0JlgtQW16LURhdGU9MjAyNjEwMjVUMTMwODIyWiZYLUFtei1FeHBpcmVzPTMwMCZYLUFtei1TaWduYXR1cmU9YTViMjA4MGJlZTQ0YjIzMTg3YjFiMzVhOTIyMmFhY2UwZDBiOTgwM2NiZTA0NDkxMjlkNjg2MTFjYzNjNjQyZSZYLUFtei1TaWduZWRIZWFkZXJzPWhvc3QmcmVzcG9uc2UtY29udGVudC10eXBlPXZpZGVvJTJGbXA0In0.8NXZRTevc3z4rr6W18lRkJ3DzYxgY83WLJBT_Ct6SW0)

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

Agentic coding changed software over-night. But for high-craft engineering, the direction between tools and the reality of engineering work keeps widening. [Agents create decoherent systems](https://maevyn.codes/decoherence) over time, when not properly guided, and human understanding and real engineering standards are still required for complex systems.

We have ADEs, Agent GUIs, TUIs, and plugins like Plannotator. There are a lot of good ideas out there, but I don't want to jump between apps just to get an inferior version of tools my editor already has, like diffs without the LSP features and editing which my editor was built to provide for exploration and quick iteration.

I didn't need a second app, I needed a tighter integration between my agent and editor. So I built this...

# Features at a glance

| Feature | What it does |
| --- | --- |
| 🤖 **Agent status** | Live status and notifications from your agent |
| 👩🏽‍💻 **Changed Files** | Edit from any git comparison and multiple view modes |
| 📋 **Plan review** | Feed back on agent plans before implementation |
| 🔍 **Code review** | Review completed agent code before accepting it |
| 🧭 **Guided review** | Your agent groups a branch's changes into described changesets to read in order |
| 🗂️ **Repository & Worktree** | Management and switching, with multi-repo agent visiblity |

# Installation

Paireto comes in two parts:

1. The [**VS Code extension**](https://marketplace.visualstudio.com/items?itemName=Paireto.paireto)
2. An agent plugins (focused on TUI agents)

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
| **Pi** | ✅ Supported |
| Others? | ＃ Open an Issue |

# Workflows

## Plan Mode

When your agent finishes planning, the plan opens in Paireto. You can leave inline comments from the VS Code editor, then click **Approve** or **Send Feedback** to instruct the agent. When the revision comes back, you'll get a diff so you only need to re-read what actually changed.

**Pi has no plan mode of its own, so Paireto adds one.** Start the turn with `/paireto-plan <what you want>` to use this.

## Review Mode

When your agent tries to end its turn with any changes made, a review is (by default) started automatically. You can also start a review at any time with the `/paireto:review` skill. (Note: Kiro is not automatic due to harness limitations)

Diffs are fully functional editors with LSPs and linters working as normal. Add inline comment from VS Code edit or diff tabs. Click **Send Feedback** to hand over your comments, or **Approve** to let the agent finish. 

## Guided Review

**Guided Review** populates the Changed Files list with a structured review plan, guiding you through the changes in a more linear and organized manner. Ask your agent for a guided review `/paireto:guided-review` and it studies the changes, then hands over to Paireto.

Comment on a file diff as usual, or on a changeset's description to give feedback on the grouping
itself. Finish with the usual **Approve** or **Send Feedback**.

## Changed Files view

**Changed Files** is the like native git panel but on steroids: pick what to **Compare To** (HEAD, merge-base, stack-base, default branch, or any other ref), add review comments for your agent, and step in manually to fix code. You can even use it on other people's PRs to leave feedback via the GitHub extension.

The **Compare To** button lets you choose any git ref to compare against: HEAD, merge-base, stack-base, default branch, or enter a ref of your choosing.

Use the **View Modes** button on the section to pick the layout (tree or flat) and one of three views. The picker stays open, so you can change both in one go:

- **Staging** groups the changes into Committed, Staged and Working Tree, like the native git panel.
- **Delta** shows each file once, with its net change against Compare To. The status letter shows the
  stage state: full colour is not staged, half grey is partly staged, grey is staged, and a commit icon
  is committed. Stage and unstage a file, a folder, or everything from its row.
- **Review** shows the same rows with a checkbox. Tick a file when you have read it, or tick a folder,
  repository, or the Changed Files row to mark all the files below it. A seen file has a grey status
  letter. A file you marked becomes unseen again when its content changes.

## Switch repo or worktree

Hit **`Cmd+Shift+K`** for the switcher: current window, worktrees, and recent repos, each showing
its agent activity. Manage all your VS Code windows and worktrees from any other window.


# Troubleshooting

- **Agent doesn't appear in the sidebar.** Make sure you restarted the agent after installing, and that
  the repo is open in VS Code. Set `paireto.logLevel` to `debug` and check the *Paireto* output channel.
- **Plugin didn't register.** Open `Paireto: Open Welcome`, run setup again, then restart the agent.
- **No sound on notifications.** Confirm `paireto.notify.type` is `sound` and `paireto.notify.sound`
  names a valid system sound or file path.

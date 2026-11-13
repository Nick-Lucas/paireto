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
  - [UML Diff](#uml-diff)
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
| 🧩 **UML Diff** | See a comparison as a UML class diagram and open each change in the native diff |
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

## UML Diff

**UML Diff** shows the Compare To comparison as a UML class diagram, so you can see the structure and
impact of a change before you read the code. Open it with the type-hierarchy button on the Changed
Files row, next to its name, or in the title bar of any Paireto diff. You can also run `Paireto: Open
UML Diff`.

- Classes, interfaces, enums and structs show their fields and methods with UML relationship lines:
  generalization, realization, association (with multiplicity) and dependency. Files with only
  top-level functions show as a «module» box.
- Badges mark each change: **A** added, **D** removed, **M** changed, and **S** for a member whose
  signature changed. A header pill counts `+added / −removed` lines for the whole type; a number on
  a row counts that member only.
- Click a member, a type header or a file frame to select it and follow its links. Double-click it,
  or press Enter, to open it beside the diagram the same way a Changed Files row opens: the native
  diff for a changed file, or the file itself for a new one. It opens at that member, with the
  member's lines marked. Editing, LSP features and inline comments work as normal.
- Select a type to follow its links: its lines turn bold in their own colour (green for a new link,
  red for a removed one, grey for one that did not change) and name the field or method that makes
  them, and everything unrelated fades. Click a line or a linked name to go to the other end. **L** fits
  the type and everything it links to.
- The top bar shows the comparison. Click it to compare with another branch or commit.
- A floating toolbar at the top of the diagram changes what you see. It has three menus, and each
  shows its name in grey and its current choice:
  - **Show** picks the question: All changes, API, Implementation or Fields. Each choice says what
    it shows. Related types outside the focus stay as grey boxes with a dotted outline: a **U**
    mark and a "no diff" pill when they have no change, or their grey line counts and an "outside
    focus" pill when they do.
  - **Filter** narrows any question to files **Not seen** yet or to types with **Open threads**.
    The button turns blue while a filter is on. **Clear filters** turns them all off.
  - **View** picks the layout: **By links**, with lines running left to right, or **By folder**,
    with one frame for each folder and file.
  - **Find** (/) goes to a class or file by name.

  When the diagram is narrow, the menus drop their grey names. If the toolbar still does not fit on
  one line, it changes to two lines: Show and Find on top, Filter and View below.
  A box shows its six largest changes; "show all" opens the rest. Selecting or opening never moves
  the boxes.

- **Where the changes are** sits beside the diagram. It lists the changed types, largest first,
  with their largest members. Click a row to go to it in the diagram; double-click to open its
  diff. Drag the left edge to resize the list (double-click the edge to reset it), or fold it away
  to a thin bar.
- Your review runs from the top of this list: how many files you have seen, and **Next change**
  (N). Next change selects, in turn, each changed member that the diagram shows for the current
  Show choice, or the type itself when the diagram shows none of its members. A member with several
  changed parts is one stop. It goes through every type in a file before the next file, and the row
  of that change shows which one it is in the file, for example "2 of 3". It does not open the
  diff; double-click the selection to open it. After the last change it marks the file seen and
  goes to the next file not seen, in the order of the list. A seen file has a tick and turns grey. **Start again** marks every
  file not seen again, after you confirm, so you can review from the start. When the list is folded
  away, the thin bar keeps a round Next change button and the seen count.
- Comment on the design, not only on a line: right-click a member, a type or a frame and choose
  **Add comment**. A new note opens beside that part with its thread, as in Copilot Chat: type
  in the box, pick **Comment** or **Question**, and post it. The parts the note is linked to
  show as chips beside **Link a part…** under the text. To link one, type **@** and pick a type,
  a member, a file or a frame from the list; or click **Link a part…** and then the part on the
  diagram; or drag the dot on the note's edge onto it. However you link it, its chip shows there
  at once, also in the reply box of the note's thread. A frame of linked types can cover
  many files. Right-click an empty part of the diagram to add a note with no link. The note
  shows on the diagram with a dashed arrow to each part it is linked to; the arrows go round
  the boxes and keep off the other lines, and pointing at a chip in the thread lights its arrow. Click a note to show its thread: read the agent's replies,
  reply, edit or delete your messages (an edit happens in place: Enter saves, Esc cancels), see
  which parts it is linked to, or resolve it. A click on the note's row in the Feedback list opens the UML Diff at the note, with its thread open. A badge such as **1 new reply** shows when the agent answers. Drag a note to
  move it, or select it and press Alt and an arrow key; it stays beside the type it is linked
  to, and its arrows are drawn again when you let go. Drag the thread window by its title to move
  it out of the way. In the send box, Enter posts and Shift+Enter or Ctrl+Enter adds a line. Posting, replying and editing only save; each of your messages shows **not sent** until
  you press **Send Feedback**, which is also at the top of the diagram while the agent waits
  for your review. A resolved note leaves the diagram.
- Move the view with the joypad in the corner: click an arrow to pan one step, or hold it to keep
  moving. The centre button centres the selection. **Fit all** (F) zooms out until the whole
  diagram is on screen.

The structure comes from each language's document symbols in VS Code, so any language with a symbol
provider works. Relationships come from declaration headers, field types and method signatures.

## Switch repo or worktree

Hit **`Cmd+Shift+K`** to view all your worktrees and their agent state. You can switch to another open window or replace your current window with a different worktree.

# Skills

The Paireto plugin adds these skills and commands to your agent. These docs cover the Claude Code format since other harnesses use their own syntax, for example: 

- **OpenCode, Kiro:** `/paireto-review`
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

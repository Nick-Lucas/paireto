<!-- <p align="center">
  <img src="media/PairetoHeader2x.png" alt="Paireto" width="420" />
</p> -->

> "Agents do 80% of the work, what's left to us is understanding, judgement, and coherence" - Paireto (the Parrot)

Paireto brings pair-programming to your TUI coding agents in VS Code: planning, review, editing, and worktree management, in one engineer-grade workflow.

[![Launch Video](https://private-user-images.githubusercontent.com/8896153/684046614-046b7b83-9afd-417e-8565-0005a6c16910.mp4?jwt=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJnaXRodWIuY29tIiwiYXVkIjoicmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbSIsImtleSI6ImtleTUiLCJleHAiOjE3OTI5MzQwMDIsIm5iZiI6MTc5MjkzMzcwMiwicGF0aCI6Ii84ODk2MTUzLzY4NDA0NjYxNC0wNDZiN2I4My05YWZkLTQxN2UtODU2NS0wMDA1YTZjMTY5MTAubXA0P1gtQW16LUFsZ29yaXRobT1BV1M0LUhNQUMtU0hBMjU2JlgtQW16LUNyZWRlbnRpYWw9QUtJQVZDT0RZTFNBNTNQUUs0WkElMkYyMDI2MTAyNSUyRnVzLWVhc3QtMSUyRnMzJTJGYXdzNF9yZXF1ZXN0JlgtQW16LURhdGU9MjAyNjEwMjVUMTMwODIyWiZYLUFtei1FeHBpcmVzPTMwMCZYLUFtei1TaWduYXR1cmU9YTViMjA4MGJlZTQ0YjIzMTg3YjFiMzVhOTIyMmFhY2UwZDBiOTgwM2NiZTA0NDkxMjlkNjg2MTFjYzNjNjQyZSZYLUFtei1TaWduZWRIZWFkZXJzPWhvc3QmcmVzcG9uc2UtY29udGVudC10eXBlPXZpZGVvJTJGbXA0In0.8NXZRTevc3z4rr6W18lRkJ3DzYxgY83WLJBT_Ct6SW0)](https://private-user-images.githubusercontent.com/8896153/684046614-046b7b83-9afd-417e-8565-0005a6c16910.mp4?jwt=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJnaXRodWIuY29tIiwiYXVkIjoicmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbSIsImtleSI6ImtleTUiLCJleHAiOjE3OTI5MzQwMDIsIm5iZiI6MTc5MjkzMzcwMiwicGF0aCI6Ii84ODk2MTUzLzY4NDA0NjYxNC0wNDZiN2I4My05YWZkLTQxN2UtODU2NS0wMDA1YTZjMTY5MTAubXA0P1gtQW16LUFsZ29yaXRobT1BV1M0LUhNQUMtU0hBMjU2JlgtQW16LUNyZWRlbnRpYWw9QUtJQVZDT0RZTFNBNTNQUUs0WkElMkYyMDI2MTAyNSUyRnVzLWVhc3QtMSUyRnMzJTJGYXdzNF9yZXF1ZXN0JlgtQW16LURhdGU9MjAyNjEwMjVUMTMwODIyWiZYLUFtei1FeHBpcmVzPTMwMCZYLUFtei1TaWduYXR1cmU9YTViMjA4MGJlZTQ0YjIzMTg3YjFiMzVhOTIyMmFhY2UwZDBiOTgwM2NiZTA0NDkxMjlkNjg2MTFjYzNjNjQyZSZYLUFtei1TaWduZWRIZWFkZXJzPWhvc3QmcmVzcG9uc2UtY29udGVudC10eXBlPXZpZGVvJTJGbXA0In0.8NXZRTevc3z4rr6W18lRkJ3DzYxgY83WLJBT_Ct6SW0)

# Contents

- [Contents](#contents)
- [Features at a glance](#features-at-a-glance)
- [Installation](#installation)
  - [Agent harness setup](#agent-harness-setup)
- [Why Paireto?](#why-paireto)
- [Agent support](#agent-support)
- [Workflows](#workflows)
  - [Plan Mode](#plan-mode)
  - [Review Mode](#review-mode)
  - [Guided Review](#guided-review)
  - [Changed Files view](#changed-files-view)
  - [UML Diff](#uml-diff)
  - [Switch repo or worktree](#switch-repo-or-worktree)
- [Troubleshooting](#troubleshooting)

# Features at a glance

| Feature                      | What it does                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------- |
| 🤖 **Agent status**          | Live status and notifications from your agent                                   |
| 👩🏽‍💻 **Changed Files**         | Edit from any git comparison and multiple view modes                            |
| 🧩 **UML Diff**              | See a comparison as a UML class diagram and open each change in the native diff |
| 📋 **Plan review**           | Feed back on agent plans before implementation                                  |
| 🔍 **Code review**           | Review completed agent code before accepting it                                 |
| 🧭 **Guided review**         | Your agent groups a branch's changes into described changesets to read in order |
| 🗂️ **Repository & Worktree** | Management and switching, with multi-repo agent visiblity                       |

# Installation

Paireto comes in two parts:

1. The [**VS Code extension**](https://marketplace.visualstudio.com/items?itemName=Paireto.paireto)
2. An agent plugins (focused on TUI agents)

### Agent harness setup

On first install a **Welcome** wizard will take you through setup of your agents. You can return to
this screen at any time from the Command Palette by opening `Paireto: Open Welcome`.

After plugin setup, **restart your agent** to load the Paireto integration. Open a repo in VS Code, start the agent in its terminal, and the agent appears in the Paireto sidebar.

# Why Paireto?

Agentic coding changed software over-night. But for high-craft engineering, the direction between tools and the reality of engineering work keeps widening. [Agents create decoherent systems](https://maevyn.codes/decoherence) over time, when not properly guided, and human understanding and real engineering standards are still required for complex systems.

We have ADEs, Agent GUIs, TUIs, and plugins like Plannotator. There are a lot of good ideas out there, but I don't want to jump between apps just to get an inferior version of tools my editor already has, like diffs without the LSP features and editing which my editor was built to provide for exploration and quick iteration.

I didn't need a second app, I needed a tighter integration between my agent and editor. So I built this...

# Agent support

Paireto's architecture is agent-agnostic, but still in development. We currently support

| Agent            | Status                  |
| ---------------- | ----------------------- |
| **Claude Code**  | ✅ Supported            |
| **Codex TUI**    | ✅ Supported            |
| **Kiro CLI v3**  | ✅ Supported (V3+ only) |
| **OpenCode TUI** | ✅ Supported            |
| **Pi**           | ✅ Supported            |
| Others?          | ＃ Open an Issue        |

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

## UML Diff

**UML Diff** shows the Compare To comparison as a UML class diagram, so you can see the structure and
impact of a change before you read the code. Open it with the type-hierarchy button in the Paireto
view's title bar, on the Changed Files row, or in the title bar of any Paireto diff. You can also run
`Paireto: Open UML Diff`.

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
  reply, edit or delete your messages (an edit happens in place: ⌘↵ saves, Esc cancels), see
  which parts it is linked to, resolve it, or open it in the editor. A badge such as **1 new reply** shows when the agent answers. Drag a note to
  move it, or select it and press Alt and an arrow key; it stays beside the type it is linked
  to, and its arrows are drawn again when you let go. Drag the thread window by its title to move
  it out of the way. Posting, replying and editing only save; each of your messages shows **not sent** until
  you press **Send Feedback**, which is also at the top of the diagram while the agent waits
  for your review. A resolved note leaves the diagram.
- Move the view with the joypad in the corner: click an arrow to pan one step, or hold it to keep
  moving. The centre button centres the selection. **Fit all** (F) zooms out until the whole
  diagram is on screen.

The structure comes from each language's document symbols in VS Code, so any language with a symbol
provider works. Relationships come from declaration headers, field types and method signatures.

## Switch repo or worktree

Hit **`Cmd+Shift+K`** for the switcher: current window, worktrees, and recent repos, each showing
its agent activity. Manage all your VS Code windows and worktrees from any other window.

# Troubleshooting

- **Agent doesn't appear in the sidebar.** Make sure you restarted the agent after installing, and that
  the repo is open in VS Code. Set `paireto.logLevel` to `debug` and check the _Paireto_ output channel.
- **Plugin didn't register.** Open `Paireto: Open Welcome`, run setup again, then restart the agent.
- **No sound on notifications.** Confirm `paireto.notify.type` is `sound` and `paireto.notify.sound`
  names a valid system sound or file path.

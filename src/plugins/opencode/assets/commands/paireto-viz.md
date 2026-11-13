---
description: Draw how the current changes fit together as an interactive diagram in VS Code
---

# Paireto Viz

Draw how these changes fit together, so a human sees the shape of the change before they read the code. Paireto shows the drawing in the connected VS Code window.

## 1. Ask the window what it compares

Call the `paireto_get_changes` tool. Use its Compare To, and read only the changes it lists.

## 2. Read the changes

Read the diffs themselves. Do not judge a file by its name or folder only.

## 3. Choose the level

Use `service` when several services, apps or repos change (the level hint says so). Nodes are then services, UIs, stores and queues. Use `component` when one unit changes. Nodes are then components, hooks, functions and models.

## 4. Draw the overview

- Nodes: the changed parts, plus the unchanged neighbours they touch.
- Lanes: the reader's mental model, left to right. Not folders.
- Edges: how the parts interact. Mark one `hero` edge for the main new path.
- Each node: a one-sentence `role` about its part in this change, and `files` with lines.

## 5. Add flows

Add 1-4 flows for the key processes or protocols that the change adds or alters. Put the steps in time order, with the participants as columns. Skip a flow when there is nothing to sequence.

## 6. Write the walkthrough

Write 3-7 steps. Use change words in the titles: Adds, Routes, Drops. Explain how the changes interact. Never explain line-level code decisions.

## 7. Show it

Call the `paireto_show_viz` tool. It returns at once. If it rejects the viz, fix every error and call it again. Never delete elements to pass.

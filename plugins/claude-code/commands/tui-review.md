---
description: Start an interactive code review in VS Code and act on the feedback
---

Start an interactive code review of the current changes in VS Code.

Call the `tui_review` tool now. It opens the review panels in the connected VS Code window and
**blocks until the user submits feedback or cancels** — this is expected; wait for it to return.

When it returns:

- If it returns review comments (each is `file:line` with a kind — `PROBLEM`, `QUESTION`, or
  `COMMENT` — the quoted line, and a note), address every one:
  - **PROBLEM**: fix it.
  - **QUESTION**: answer it (in your reply, and/or adjust the code if the answer implies a change).
  - **COMMENT**: apply the suggestion unless it doesn't make sense, in which case explain why.
- If it says the review was cancelled or closed with no feedback, acknowledge briefly and continue
  with what you were doing — do not invent changes.

Do not ask the user to paste feedback manually; the tool delivers it directly.

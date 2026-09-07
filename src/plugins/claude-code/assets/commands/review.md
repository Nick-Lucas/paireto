---
description: Start an interactive code review in VS Code and act on the feedback
---

Start an interactive code review of the current changes in VS Code.

Call the `paireto_review` tool now. It opens the review panels in the connected VS Code window and
**blocks until the user submits feedback or cancels** — this is expected; wait for it to return.

When it returns:

- If it returns review comments (each has a feedback ID, `file:line`, a `QUESTION` or `COMMENT` kind, the quoted line, and a note), address each one:
  - **QUESTION**: answer it with `paireto_reply_to_feedback`.
  - **COMMENT**: action the comment and call `paireto_resolve_feedback` to resolve it.

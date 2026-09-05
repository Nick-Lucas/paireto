---
description: Start an interactive code review with a human reviewer and act on the returned feedback
---

Start an interactive code review of the current changes in VS Code.

Call the `paireto_review` tool now. It opens the review panels in the connected VS Code window and
**blocks until the user submits feedback or cancels** — this is expected; wait for it to return.

When it returns:

- If it returns review comments (each has a feedback ID, `file:line`, a `QUESTION` or `COMMENT`
  kind, the quoted line, and a note), address every one:
  - **QUESTION**: answer it with `paireto_reply_to_feedback`, and adjust the code if needed.
  - **COMMENT**: apply the suggestion unless it doesn't make sense, in which case explain why with `paireto_reply_to_feedback`.
  - Call `paireto_resolve_feedback` after you finish each item.
- If it says the review was cancelled or closed with no feedback no action is needed.

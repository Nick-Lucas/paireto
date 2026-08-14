---
name: paireto-review
description: Start an interactive Paireto code review of the current changes in VS Code and act on the returned feedback. Use when the user asks to review changes with Paireto or explicitly invokes $paireto-review.
---

# Paireto Review

Call the Paireto MCP tool `mcp__paireto__paireto_review` now. It opens Paireto's review panels in the
connected VS Code window and blocks until the user submits feedback or approves the changes. Wait
for it to return.

When it returns:

- If it returns review comments (each has a feedback ID, `file:line`, a `QUESTION` or `COMMENT`
  kind, the quoted line, and a note), address every one:
  - **QUESTION**: answer it with `mcp__paireto__paireto_reply_to_feedback`, and adjust the code if needed.
  - **COMMENT**: apply the suggestion unless it does not make sense, in which case explain why with `mcp__paireto__paireto_reply_to_feedback`.
  - Call `mcp__paireto__paireto_resolve_feedback` after you finish each item.
- If it says the review was cancelled or closed with no feedback no action is needed.

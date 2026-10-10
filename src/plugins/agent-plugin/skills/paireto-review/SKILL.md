---
name: paireto-review
description: Start an interactive code review with a human reviewer and act on the returned feedback
---

# Paireto Review

Call the Paireto MCP tool whose name ends in `paireto_review` now. Its client-specific prefix can
vary. It opens Paireto's review panels in the connected VS Code window and blocks until the user
submits feedback or approves the changes. Wait for it to return.

If it returns feedback, act on each item by its kind:

- **Question**: answer it with the Paireto MCP tool whose name ends in `paireto_reply_to_feedback`. Do not
  change code for a question.
- **Comment**: make the code changes it asks for. Do not reply to a comment.

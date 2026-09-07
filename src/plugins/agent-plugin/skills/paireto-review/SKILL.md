---
name: paireto-review
description: Start an interactive code review with a human reviewer and act on the returned feedback
---

# Paireto Review

Call the Paireto MCP tool whose name ends in `paireto_review` now. Its client-specific prefix can
vary. It opens Paireto's review panels in the connected VS Code window and blocks until the user
submits feedback or approves the changes. Wait for it to return.

When it returns:

- Address every review comment. Each carries a feedback ID. Answer each `QUESTION` with the tool
  whose name ends in `paireto_reply_to_feedback`, and apply each `COMMENT` unless it does not make
  sense; explain any suggestion you do not apply. Call the tool whose name ends in
  `paireto_resolve_feedback` once you have finished an item.
- If the review was approved or closed without feedback, acknowledge that briefly and continue.

Do not run a shell helper or ask the user to paste feedback manually; the tool returns it directly.

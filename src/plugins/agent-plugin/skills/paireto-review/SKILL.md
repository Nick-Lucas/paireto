---
name: paireto-review
description: Start an interactive code review with a human reviewer and act on the returned feedback
---

# Paireto Review

Call the Paireto MCP tool whose name ends in `paireto_review` now. Its client-specific prefix can
vary. It opens Paireto's review panels in the connected VS Code window and blocks until the user
submits feedback or approves the changes. Wait for it to return.

When it returns:

If it returns feedback, address every item.

Reply to questions with the `paireto_reply_to_feedback` tool.

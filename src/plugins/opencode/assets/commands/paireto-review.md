---
description: Start an interactive code review with a human reviewer and act on the returned feedback
---

Start an interactive code review of the current changes in VS Code.

Call the `paireto_review` tool now. It opens the review panels in the connected VS Code window and
**blocks until the user submits feedback or cancels** — this is expected; wait for it to return.

When it returns:

If it returns feedback, address every item.

Reply to questions with the `paireto_reply_to_feedback` tool.

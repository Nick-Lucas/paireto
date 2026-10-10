---
name: paireto-review
description: Start an interactive code review with a human reviewer and act on the returned feedback
---

# Paireto Review

Start an interactive code review of the current changes in VS Code.

Call the `paireto_review` tool now. It opens the review panels in the connected VS Code window and
**blocks until the user submits feedback or cancels** — this is expected; wait for it to return.

If it returns feedback, act on each item by its kind:

- **Question**: answer it with the `paireto_reply_to_feedback` tool. Do not change code for a question.
- **Comment**: make the code changes it asks for. Do not reply to a comment.

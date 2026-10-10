---
name: paireto-review
description: Start an interactive code review with a human reviewer and act on the returned feedback
---

# Paireto Review

Start an interactive code review of the current changes with a human reviewer. Paireto tool names can have a client-specific prefix.

## 1. Submit

Call the `paireto_review` tool now. It opens the review in the connected VS Code window and blocks until the reviewer sends feedback or approves the changes. This is expected. Wait for it to return.

## 2. Act on the feedback

If it returns feedback, act on each item by its kind:

- **Question**: answer it with the `paireto_reply_to_feedback` tool. Do not change code for a question.
- **Comment**: make the code changes it asks for. Do not reply to a comment.

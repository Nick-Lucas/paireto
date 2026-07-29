---
name: paireto-review
description: Start an interactive Paireto code review of the current changes in VS Code and act on the returned feedback. Use when the user asks to review changes with Paireto or explicitly invokes $paireto-review.
---

# Paireto Review

Resolve `scripts/review.js` relative to this `SKILL.md`, then run `node <absolute-script-path>` with
the user's repository as the command's working directory. The command opens Paireto's review panels
in the connected VS Code window and blocks until the user submits feedback or approves the changes.
Wait for it to return.

When it returns:

- Address every review comment. Treat `PROBLEM` as a required fix, answer each `QUESTION`, and apply
  each `COMMENT` unless it does not make sense; explain any suggestion you do not apply.
- If the review was approved or closed without feedback, acknowledge that briefly and continue.

Do not ask the user to paste feedback manually; the command returns it directly.

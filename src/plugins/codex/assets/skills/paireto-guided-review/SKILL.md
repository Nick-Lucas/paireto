---
name: paireto-guided-review
description: Study the current changes, group them into named changesets, and submit that review plan to Paireto for a human reviewer. Use when the user asks for a guided review or invokes $paireto-guided-review.
---

# Paireto Guided Review

Prepare a review plan so a human can review these changes, then hand it to Paireto.

## 1. Choose what to compare

Use the comparison the user asks for. If they do not specify one then default to the merge base. Review only what is inside that comparison.

## 2. Read the changes

`git diff --stat` for that comparison, then the diffs themselves. Do not judge a file by its name/directory only.

## 3. Group them

Group the changed files into changesets representing logical threads or features to follow — one feature, fix, or refactor per changeset. Files should be included in the order they should be read, and one file may be included in multiple changesets.

## 4. Submit

Call `mcp__paireto__paireto_start_guided_review` once, with every changeset and the `compareTo` from step 1. It blocks until the reviewer responds.

If it returns comments then action them appropriately.

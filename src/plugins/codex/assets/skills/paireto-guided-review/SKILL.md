---
name: paireto-guided-review
description: Study the current changes, group them into named changesets, and submit that review plan to Paireto for a human reviewer. Use when the user asks for a guided review or invokes $paireto-guided-review.
---

# Paireto Guided Review

Prepare a review plan so a human can review these changes, then hand it to Paireto.

## 1. Choose what to compare

Use the comparison the user asked for. If they named none, use `mergeBase`, or `head` when the branch
has no commits of its own. Review only what is inside that comparison.

- `head` — uncommitted work (staged and working tree).
- `mergeBase` — this branch since it forked from the default branch.
- `default` — against the default branch tip.
- `ref` — against a named ref; report the ref too.

## 2. Read the changes

`git diff --stat` for that comparison, then the diffs themselves. Do not judge a file by its name.

## 3. Group them

Group the changed files by intent — one feature, fix, or refactor per changeset. Each changeset needs
a title, a description of what it does and why, and its files in the order they should be read. Add a
`note` to a file when its role is not obvious.

## 4. Submit

Call `mcp__paireto__paireto_start_guided_review` once, with every changeset and the `compareTo` from step 1. It blocks until the reviewer
responds.

If it returns comments (`file:line`, a kind, the quoted line, and a note), address each one: fix a
`PROBLEM`, answer a `QUESTION`, apply a `COMMENT` unless it does not make sense — then say why. A
`Changeset` comment is about the grouping; regroup and submit again. If it returns approval,
acknowledge and continue.

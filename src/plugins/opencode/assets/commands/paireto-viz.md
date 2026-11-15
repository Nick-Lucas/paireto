---
description: Draw how the current changes fit together as an interactive diagram in VS Code
---

# Paireto Viz

Draw how these changes fit together, so a human sees the shape of the change before they read the code. A viz is one JSON file in the repo, `.paireto/viz/<name>.viz.json`. Paireto shows it in the connected VS Code window.

## 1. Choose the base

- Use `changes` when the diagram is about code structure, types, modules, calls, or what a change touches. Paireto builds class nodes from the Compare To diff with the language servers.
- Use `none` for concepts the code does not name, such as a business process, a deploy topology or a trust boundary. Also use it for a design of code that does not exist yet, for topology across systems or repos that are not open in the window, and for a one-off explanation where a hand layout is clearer. You draw every node.
- Neither base is a fallback. Choose the one that fits the question.

## 2. Generate the file

Call the `paireto_viz_generate` tool with `name` (lowercase letters, digits and `-`), `base`, and an optional `title`. It writes the file and returns its absolute path, the node and edge counts, and the change summary. The summary gives the Compare To, each repo, the changed files, the units and a level hint. The tool replaces a file that has the same name.

## 3. Read the changes

Read the diffs of the files that the summary lists. Do not judge a file by its name or folder only.

## 4. Edit the file

Read the file, then edit it with your usual file edit tools.

- Replace the placeholder `summary` with 1-3 sentences about what changed and why it matters.
- Keep the generated nodes, members, deltas and `files` unless they are wrong.
- Do not change `version`, `base`, `compareTo` or `generatedAt`.
- Give each node a one-sentence `role` about its part in this change.
- Follow the level hint. At `service` level, nodes are services, UIs, stores and queues. At `component` level, nodes are components, hooks, functions and models.
- Add architecture nodes for the parts that the code does not name, such as a `service`, `queue`, `datastore`, `ui` or `external`.
- Set `parent` to put nodes in a `package` or `system` frame.
- Add `edges` with a short verb or protocol `label`, such as `POST /charges`.
- Mark at most one edge as `hero`, for the main new path.
- Add 1-4 `flows` for the key processes or protocols that the change adds or alters. Skip flows when there is nothing to sequence.
- Write a `walkthrough` of 3-7 steps. Use change words in the titles: Adds, Routes, Drops. Explain how the changes interact. Never explain line-level code decisions.

## 5. Use the components

The node `kind` picks the component.

- `class`, `interface`, `enum`, `struct`, `module` and `file` draw a UML class box with `members`.
- A member `kind` is `field`, `property`, `method`, `constructor` or `variant`. Its `label` is the signature. Set `visibility`, `isStatic` and `isAbstract` when they apply. Set `previous` to the old signature when it changed.
- `package` and `system` draw a frame around the nodes whose `parent` names them.
- All other kinds draw an architecture card.
- UML edge kinds are `extends`, `implements`, `association`, `aggregation`, `composition` and `dependency`, with an optional `multiplicity`.
- Architecture edge kinds are `call`, `event`, `data`, `render` and `uses`.

```json
{
  "id": "PaymentClient",
  "label": "PaymentClient",
  "kind": "class",
  "delta": "changed",
  "role": "Sends each charge to the new payments service.",
  "files": [{ "path": "src/pay/client.ts", "line": 12, "endLine": 40 }],
  "members": [
    {
      "id": "PaymentClient.charge",
      "kind": "method",
      "label": "charge(order: Order): Promise<Receipt>",
      "previous": "charge(order: Order): Receipt",
      "delta": "changed"
    }
  ]
}
```

A flow draws as a sequence diagram.

- The `participants` are lifelines, left to right.
- The `steps` are messages in time order. A step `kind` is `sync`, `async` or `return`. A step with the same `from` and `to` is a self step.
- A step `phase` starts a named phase.
- A fragment groups a 1-based range of steps. Its `kind` is `alt`, `opt`, `loop`, `par` or `break`.

```json
{
  "id": "checkout",
  "title": "Checkout",
  "delta": "changed",
  "participants": ["Cart", "PaymentClient", "payments"],
  "steps": [
    { "from": "Cart", "to": "PaymentClient", "label": "charge(order)", "phase": "Pay" },
    { "from": "PaymentClient", "to": "payments", "label": "POST /charges" },
    { "from": "payments", "to": "PaymentClient", "label": "402 declined", "kind": "return" }
  ],
  "fragments": [{ "kind": "opt", "label": "card declined", "from": 3, "to": 3 }]
}
```

## 6. Prevent common errors

- Ids are unique across nodes, members, edges and flows. Two edges with the same `from`, `to` and `kind` each need their own `id`.
- Each `parent`, `lane`, edge end, `via` member, participant and step `edge` names an item that exists.
- `fromMember` and `toMember` are members of the node at that end of the edge.
- A step's `from` and `to` are participants of its flow. A step `edge` joins the two ends of the step.
- A fragment ends at or before the last step. Fragments nest inside each other or do not touch.
- A `flowOnly` node is not on the diagram. Do not put it on an edge.
- One walkthrough step focuses on items of the diagram only, or on items of one flow only. Refer to a flow step as `{ "flow": "checkout", "step": 2 }`.
- A `files` path is repo-relative, and the file is in the changes or on disk. For removed code, set `side` to `base`. For a file in another repo, set `repo`.
- Put each changed file on a node, member, edge or step.
- Give each changed node a `role` and `files`.

## 7. Present it

Call the `paireto_viz_present` tool with `name`. It checks the file.

- If it returns errors, each error has a JSON path into the file, for example `nodes[3].parent`. Fix every error in the file and call it again. Never delete items to pass.
- If the file is correct, it opens the viz in VS Code and returns a summary and warnings. Fix the warnings that show a real gap, then call it again.

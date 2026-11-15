# PR #74 and PR #77: what to keep

This document compares the two visualisation PRs. It is the input to the shared core design in [02-architecture.md](02-architecture.md).

- **PR #74** (`add-paireto-viz-webview-skill`, `/paireto:viz`). The agent writes a JSON payload. Paireto validates it, lays it out, and shows an overview graph and sequence flows in a ReactFlow webview.
- **PR #77** (`expiracy:claude/paireto-uml-diff-view-26ea2a`, UML Diff). Paireto builds a UML class diagram from VS Code symbol providers for the current Compare To. Notes on the diagram are review threads.

> PR #78 (`show-all-files-delta-review`) adds an All Files option and a Reveal Active File command. It has no diagram code, so this document does not include it.

## Summary

The two PRs are complementary halves of one feature.

| Concern | PR #74 (agent viz) | PR #77 (UML Diff) |
| --- | --- | --- |
| Who makes the graph | The agent, by hand, for every element | Paireto, from `executeDocumentSymbolProvider` and text heuristics |
| Granularity | Services and components. Fixed-size cards | Types and members. Variable-height class boxes |
| Diagram kinds | Overview graph, sequence flows | Class diagram only |
| Delta model | `added / changed / deleted / unchanged` per node, edge and step | Per type and per member, with `signature` vs `body`, line counts, spans with a diff side |
| Edge kinds | `call / event / data / render / uses` | `generalization / realization / association / dependency`, with multiplicity, roles and `via` members |
| Renderer | `@xyflow/react` with a custom edge | Hand-written SVG in one large React component |
| Layout | ELK layered (overview), custom pure sequence layout | ELK layered, custom label placement, custom orthogonal router for note arrows |
| Validation | zod schema plus a table of 25 rules, path-located errors with "did you mean" | None needed (programmatic) |
| Step-through | Agent walkthrough with camera and veil, flow playback, focus | "Next change" over changed members, marks files seen |
| Comments | None | Notes are `ReviewThread`s with a `diagram` anchor, sent through Send Feedback |
| Code preview | None (opens the file or diff) | None (opens the diff at the member) |
| Portability | Mermaid export (lossy) | None |
| Agent role | Author of everything | Reads and answers notes only |
| Tests | About 105 pure unit tests | About 94 pure unit tests |
| Biggest file | `compile.ts`, 623 lines | `Diagram.tsx`, 2424 lines (one 1425-line component) |

## PR #74: good parts

- **Compile and rule table.** `src/viz/model/compile.ts` runs a zod parse, then a table of rules over an index. Each error has a JSON path and a suggestion. This pattern works for any producer, not only an agent.
- **Pure interaction core.** `VizIndex`, the `reduceUi` reducer (`explore | focus | walk | play`), `emphasisOf` and `keymap` are pure and have tests. One model drives walkthrough, playback, focus and search.
- **Layout seam.** ELK comes in through an `ElkLike` interface. Layout returns scene types (`OverviewScene`, `SequenceScene`). `rf.ts` converts scenes to xyflow elements. The renderer only draws.
- **Sequence layout.** `layout/sequence.ts` handles lifelines, activations, nesting, self steps and phases. No other part of either PR does this.
- **Host ports.** `VizService` takes injected ports, so the host has tests without VS Code.
- **Compare To alignment and history.** A viz records its Compare To, and the panel can align the window to it.
- **Skill parity test.** One skill text for each harness, with a test that stops drift.

## PR #74: bad parts

- **The agent writes everything.** It writes ids, lanes, line numbers and deltas by hand. Paireto checks only file existence, git status per node, and coverage. A payload is 6 to 10 KB, and each retry sends it again.
- **One closed vocabulary.** Node kinds mix architecture words (`queue`, `datastore`) with React words (`hook`, `render`). `hero`, `lanes` and `level` are domain rules inside the core type.
- **No UML.** Cards have a fixed size and no members. There is no inheritance edge. Only one edge per node pair. No self edges.
- **Ref grammar blocks symbol ids.** The id regex is `^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$`, and refs use `>` and `:` as separators. A symbol-derived id such as `src/a.ts#Foo.bar` cannot exist.
- **Groups are free text.** A group is a string, not an element. Refs cannot target it, and it cannot nest.
- **Whole snapshots only.** Each call replaces the viz. Nothing can add to a programmatic base graph.
- **No comments, no code preview.** File refs have no old or new side.
- **ELK on the main thread.** The index is built twice, once on the host and once in the webview.

## PR #77: good parts

- **Delta vocabulary.** Type and member change kinds, `signature` vs `body`, per-member line counts and spans with a side, relation `change`, and `via` / `roles` that tie an edge to the members that cause it. This is the best diff overlay in either PR.
- **Notes are review threads.** A note is a `ReviewThread` with a `diagram?: DiagramAnchor`. It goes through the existing `FeedbackSession` and the Send Feedback gate. The agent's reply comes back into the note. This is the correct integration point.
- **Base-side symbols.** It asks the symbol provider for the `paireto-review:` URI, and falls back to a temp file. It has a per-file cache, a retry, and file and size caps.
- **`openAgainstCompareToAt`.** A host API that opens the diff at a member and decorates its lines.
- **Grouping ideas.** "By links" (connected components) and "By folder" frames.
- **Pure core modules with tests.** `focus`, `nextChange`, `hotspots`, `fileDiff`, `outline`, `comments`.

## PR #77: bad parts

- **Relations are text heuristics.** Supertypes come from header text after the type name. Associations are any identifier in a field type that matches a known type name. Names resolve by short name, so a clash picks the wrong type without a warning. It does not use references, definition, type hierarchy or call hierarchy.
- **Language special cases.** It has regexes for Rust `impl X for Y` and Go receivers, and a keyword list for 7 languages. Go embedding, TS type aliases and C/C++ header splits do not work.
- **Base side on project servers.** rust-analyzer, jdtls and gopls may not analyse a lone temp file. The file then falls back to a plain box.
- **Giant files and local state.** `Diagram.tsx` has one 1425-line component with 86 hooks. `uml.css` is 2951 lines. There is no store.
- **Layout coupled to the renderer.** `layout.ts` mixes ELK graph building, text measuring, note placement and label collision, and returns SVG-specific metrics. It does not move to ReactFlow without a rewrite.
- **Note anchors do not move.** Anchors are name-based ids plus `file:line` copies taken at creation. It does not use the existing `relocateReviewAnchor`.
- **Full rebuild.** Every review state change sends the whole model again, after a 250 ms debounce. There is a 250-file cap.
- **No agent input.** The agent cannot add edges or annotations.

## What goes into the shared core

| Keep | From | Change for the core |
| --- | --- | --- |
| zod schema plus rule table, path-located errors | #74 | Rules declare which producers they apply to. Agent-only rules (role, coverage, hero) become opt-in |
| `VizIndex`, `reduceUi`, `emphasisOf`, `keymap` | #74 | Generalise over view kinds, not only overview and sequence |
| `ElkLike` seam, scene types, `rf.ts` | #74 | Run ELK in a Web Worker |
| Sequence layout | #74 | Add `alt / loop / opt / par` fragments |
| ReactFlow renderer | #74 | Add a class-box node type with compartments |
| Delta vocabulary for members and edges | #77 | Becomes a generic overlay on any element |
| Notes as `ReviewThread` with a diagram anchor | #77 | Anchor to element ids and to code anchors that use `relocateReviewAnchor` |
| Symbol extraction from symbol providers | #77 | Becomes one producer. Relations come from LSP queries first, heuristics last, each with provenance |
| `openAgainstCompareToAt` | #77 | Shared host action for every view |
| Grouping (by links, by folder) | #77 | Becomes view projections, not layout code |
| Mermaid export | #74 | Export from the IR, per view kind |

| Drop | From | Reason |
| --- | --- | --- |
| Hand-written SVG renderer and `route.ts` | #77 | ReactFlow does the same job. Note arrows can use a ReactFlow edge |
| `layout.ts` label placement | #77 | Coupled to SVG metrics. Rebuild only where ReactFlow output is not good enough |
| Fixed-size cards, ref string grammar, id regex | #74 | Block symbol ids and members |
| Text-based relation inference as the main source | #77 | Keep it only as a low-confidence fallback |

# Shared viz core: planning notes

These notes plan one visualisation core for Paireto. The core joins two open PRs:

- **PR #74** `/paireto:viz`. The agent writes an overview graph and sequence flows.
- **PR #77** UML Diff. Paireto builds a class diagram from symbol providers. Notes on it are review threads.

This is a plan for review. It is not final code.

| Document | Contents |
| --- | --- |
| [01-comparison.md](01-comparison.md) | Good and bad parts of each PR, and what the core keeps |
| [02-architecture.md](02-architecture.md) | Layers, module map, delivery order |
| [03-model.md](03-model.md) | The data model: elements, members, relations, walks, tours, views, layers |
| [04-protocols.md](04-protocols.md) | MCP tools, host and webview messages, comments, snippets, exporters |
| [05-seams.md](05-seams.md) | Cross-language seams, evidence, verification, LSP coverage |

## Answers to the open questions

### Is UML correct for all of this?

No. UML is one notation, and the core needs a model that several notations can draw. The core has one model of elements and relations, plus views that draw part of it as a graph, as class boxes, or as a sequence. This is the split that Structurizr and LikeC4 use. UML class boxes are one renderer for elements that have members.

No existing format meets all the needs. The research checked Mermaid, D2, PlantUML, DOT, ELK JSON, JSON Canvas, Structurizr, LikeC4, Cytoscape JSON, JGF, GraphML and SysML v2. None has typed nesting, members, sequences, an open metadata bag and a JSON Schema together. So the core has its own small JSON model, shaped close to ELK's input, with Mermaid export. Mermaid import is not practical, because Mermaid has no official parser AST for flowchart, sequence or class diagrams.

Agents write Mermaid well, but Mermaid has no place for file references, delta or evidence. A strict zod schema with path-located errors gives reliable agent output, as #74 shows. The bigger gain is that the agent writes much less. It refers to ids that LSP made, and it adds only what LSP cannot know.

### How do we handle seams across languages?

LSP builds the graph inside each language. The agent, and later contract and config producers, add seam edges between the graphs. A seam is an `endpoint` or `topic` element with an edge on each side. Each agent seam edge has evidence: a code place and a join key such as `POST /orders`. Paireto checks that the code at that place holds the key and sits inside the right symbol. The diagram then shows the edge as verified, partial or unverified. See [05-seams.md](05-seams.md).

## Decisions in this plan

1. One model with views, not one model for each diagram kind.
2. Opaque string ids. Symbol ids from producers, `a:` ids from the agent. Structured refs, not a ref string grammar.
3. Each producer writes its own layer. The agent never redraws the programmatic graph. A refresh of one layer does not erase another.
4. Sequence diagrams and flow playback use one `Walk` model. The narrated walkthrough is a `Tour` that can move across views.
5. Delta is an overlay on any element, member, relation or step. The vocabulary comes from #77.
6. Diagram comments stay `ReviewThread`s. Each target keeps a `ReviewAnchor`, so comments follow moved code.
7. ReactFlow renders every view. The #77 SVG renderer and its custom router go.
8. ELK runs in a Web Worker. The sequence layout from #74 stays.
9. Mermaid and D2 export only. JSON is the lossless format.
10. The agent layer is a file, `.paireto/viz/<name>/agent.json`, that the agent edits with its file tools. Paireto writes `generated.json` beside it. Each file has one writer.
11. A repo can hold many named vizzes. The panel opens only from the skill, through MCP.

## Resolved questions

1. **Generated or bespoke diagrams.** Both stay, and the agent chooses for each viz. `paireto_viz_create(base: "changes")` starts from the LSP graph. `base: "none"` lets the agent draw a bespoke diagram, as in #74. A bespoke diagram can still carry code refs, comments and snippets. See [Choosing a base](04-protocols.md#choosing-a-base).
2. **When the LSP graph is built.** Only when the agent calls `paireto_viz_create` or `paireto_viz_refresh`. The panel opens only from the skill. The agent edits its layer as a file in `.paireto/viz/<name>/agent.json`. See [04-protocols.md](04-protocols.md#1-viz-files-and-mcp-tools).
3. **PR #77 renderer.** Agreed to replace it with the shared ReactFlow renderer.

## Questions for the reviewer

1. **UML Diff without an agent.** #77 opens a class diagram from a button on the Changed Files row, with no agent. In this plan, a viz exists only after the agent makes one. Do we drop the button, or keep a command that runs `create` with only the generated layer?
2. **Commit `.paireto/`?** This plan hides `.paireto/` through `.git/info/exclude`, so it never shows as a change. A team could want to commit a viz as design documentation. Is that a use case?
3. **Code snippet colours.** Shiki in the webview, or plain text with diff marks first?
4. **Contract producers.** Is OpenAPI and proto detection in scope for the first release, or do agent seam edges come first?

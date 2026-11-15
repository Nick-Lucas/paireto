# Shared viz core: protocols

This document describes four protocols:

1. The viz files the agent edits, and the MCP tools around them.
2. The host and webview messages.
3. The path from a diagram comment to the agent and back.
4. Code snippet preview.

## 1. Viz files and MCP tools

The agent writes its part of a viz as a JSON file, with the same file tools it uses for code. MCP tools generate the programmatic part, check the result, and open the panel.

Agents edit files well. A file edit changes a few lines, and the agent does not have to send a 6 to 10 KB payload again on each retry, as it does in #74. The file also stays after the session ends.

### Files

```text
<repo root>/.paireto/
  viz/
    schema.json            JSON Schema for agent.json (made from the zod schema)
    <name>/
      generated.json       Programmatic layers: lsp, delta. Paireto writes it. Read-only for the agent
      agent.json           The agent layer. Only the agent writes it
      snapshot.json        The merged, compiled doc at the last successful check. Paireto writes it
```

Rules:

- **One writer for each file.** Paireto writes `generated.json` and `snapshot.json`. The agent writes `agent.json`. A refresh of the generated layer never erases the agent's work.
- **User state is not in these files.** Comments stay in the review store as `ReviewThread`s. Node positions, zoom and filters stay in `workspaceState`. So the user and the agent never write the same file.
- **`.paireto/` must not show as a change.** Paireto lists changes, so its own files must not appear in the list. Paireto adds `.paireto/` to `.git/info/exclude` when it creates the folder. That file is local, so this does not change the user's `.gitignore`.
- **`generated.json` is the query surface.** The agent finds `sym:` ids with `grep` or by reading the file. There is no separate query tool. The file holds the changed files and one hop of neighbours, so it stays small.
- `agent.json` starts with `"$schema": "../schema.json"`. VS Code then checks the file in the editor for a human too.

```jsonc
{
  "$schema": "../schema.json",
  "title": "Order checkout",
  "summary": "Adds a billing step after an order is created.",
  "elements": [
    { "id": "order-created", "kind": "topic", "label": "orders.created" }
  ],
  "relations": [
    {
      "kind": "publishes",
      "from": { "element": "sym:orders-api/events/publish.go#PublishOrderCreated" },
      "to": { "element": "order-created" },
      "evidence": [{ "at": { "repo": "orders-api", "path": "events/publish.go", "side": "modified", "range": { "start": 41, "end": 41 } }, "key": "orders.created" }]
    }
  ],
  "patches": [
    { "op": "annotate", "ref": { "element": "sym:orders-api/handlers/orders.go#CreateOrder" }, "role": "Accepts the order and publishes the event." }
  ],
  "walks": [],
  "tours": [],
  "views": []
}
```

### MCP tools

| Tool | Purpose | Replaces |
| --- | --- | --- |
| `paireto_get_changes` | Compare To, changed files, units, level hint | Same tool in #74 |
| `paireto_viz_create` | Make `.paireto/viz/<name>/`. Write `generated.json` and an empty `agent.json` | New |
| `paireto_viz_check` | Merge, compile and verify. Write `snapshot.json`. Return errors | The validation half of `paireto_show_viz` |
| `paireto_viz_open` | Open the panel on a viz and a view | The panel half of `paireto_show_viz` |
| `paireto_viz_refresh` | Build `generated.json` again for the current Compare To. Report agent refs that broke | New |
| `paireto_viz_list` | List the vizzes, their Compare To and the date of the last check | #74 history picker |

```ts
interface VizCreateArgs {
  name: string;
  base?: "changes" | "none";
  scope?: { paths?: string[]; hops?: number };
}

interface VizCreateResult {
  dir: string;
  generated: string;
  agent: string;
  status: "complete" | "partial";
  missing?: string[];
  counts: { elements: number; relations: number };
}

interface VizCheckArgs { name: string }
interface VizOpenArgs { name: string; view?: ViewId; focus?: VizRef }
interface VizRefreshArgs { name: string }
```

- `base: "changes"` builds the LSP and delta layers for the current Compare To. This is the default.
- `base: "none"` writes an empty `generated.json`. The agent draws everything, as in #74. This is for a design that has no code yet, such as a proposed architecture during plan review. It costs nothing extra, because it is the same pipeline with an empty programmatic layer.
- `status: "partial"` names the capabilities that are missing, such as `typeHierarchy` for TypeScript. The agent can then add those edges with evidence.
- If `agent.json` does not set `views`, Paireto adds the presets: "Changes" (graph), "Types" (class) and one sequence view for each walk.

### Check result

`paireto_viz_check` and `paireto_viz_refresh` return the same shape. It keeps the #74 error style. Every error has a path into `agent.json` and a suggestion.

```ts
interface VizCheckResult {
  ok: boolean;
  counts: { elements: number; relations: number; walks: number };
  errors: { path: string; rule: string; message: string; suggestion?: string }[];
  warnings: { path: string; rule: string; message: string }[];
  seams?: { relation: string; verification: "verified" | "partial" | "unverified" | "failed"; reason?: string }[];
}
```

### Live updates

Paireto watches `agent.json` while the panel is open. When the file changes, Paireto checks it again.

- If the check passes, the panel shows the new doc.
- If the check fails, the panel keeps the last good doc and shows an error banner. The same errors appear as VS Code diagnostics on `agent.json`.
- The agent still calls `paireto_viz_check` to get the errors as a tool result. The watcher is for the human who watches the panel.

### Agent flow

```mermaid
sequenceDiagram
  autonumber
  actor User
  participant Agent
  participant MCP as MCP server
  participant Host as VizService
  participant LSP as LSP producer
  participant FS as .paireto/viz/name
  participant Core as merge + compile + verify
  participant View as Webview

  User->>Agent: /paireto:viz
  Agent->>MCP: paireto_get_changes
  MCP->>Host: changes request
  Host-->>Agent: Compare To, files, units, level hint
  Agent->>MCP: paireto_viz_create(name)
  MCP->>Host: create request
  Host->>LSP: build layers for Compare To
  LSP-->>Host: lsp layer, delta layer (partial: typeHierarchy)
  Host->>FS: write generated.json, empty agent.json
  Host-->>Agent: paths, counts, missing capabilities
  Agent->>FS: grep generated.json for sym: ids
  Note over Agent: Read diffs. Find seams that LSP cannot follow.
  Agent->>FS: edit agent.json (walks, roles, seam edges)
  Agent->>MCP: paireto_viz_check(name)
  MCP->>Host: check request
  Host->>FS: read generated.json, agent.json
  Host->>Core: merge, compile, verify seam evidence
  alt errors
    Core-->>Agent: ok false, errors with paths in agent.json
    Agent->>FS: fix agent.json
    Agent->>MCP: paireto_viz_check(name)
  end
  Core-->>Host: doc, index, seam results
  Host->>FS: write snapshot.json
  Host-->>Agent: ok true, counts, seam results
  Agent->>MCP: paireto_viz_open(name)
  MCP->>Host: open request
  Host->>View: load(doc, index, threads)
```

### Refresh after code changes

```mermaid
sequenceDiagram
  autonumber
  participant Agent
  participant Host as VizService
  participant LSP as LSP producer
  participant FS as .paireto/viz/name
  participant Core as merge + compile + verify

  Agent->>Host: paireto_viz_refresh(name)
  Host->>LSP: build layers for Compare To
  Host->>FS: write generated.json
  Host->>FS: read agent.json
  Host->>Core: merge, compile, verify
  Core-->>Host: refs to sym: ids that are gone, seams that now fail
  Host-->>Agent: errors with suggestions (renamed symbols)
```

## 2. Host and webview messages

The host sends the doc and the index once, then sends small updates. #77 sends the whole model again after each review change. This design does not.

```ts
type HostToWebview =
  | { t: "load"; doc: VizDoc; index: VizIndexData; threads: ThreadSummary[]; window: WindowInfo }
  | { t: "layer"; layer: Layer; index: VizIndexData }
  | { t: "delta"; layer: Layer }
  | { t: "threads"; threads: ThreadSummary[] }
  | { t: "seen"; files: string[] }
  | { t: "snippet"; requestId: string; snippet: Snippet | { error: string } }
  | { t: "focus"; ref: VizRef }
  | { t: "window"; window: WindowInfo };

type WebviewToHost =
  | { t: "ready" }
  | { t: "open"; code: CodeRef; mode: "diff" | "file" }
  | { t: "snippet"; requestId: string; code: CodeRef; context?: number }
  | { t: "comment.add"; anchor: DiagramAnchor; body: string; kind: "comment" | "question" }
  | { t: "comment.reply" | "comment.edit"; threadId: string; body: string }
  | { t: "comment.link" | "comment.unlink"; threadId: string; ref: VizRef }
  | { t: "comment.move"; threadId: string; place: NotePlace }
  | { t: "comment.resolve" | "comment.delete" | "comment.read"; threadId: string }
  | { t: "seen"; path: string; seen: boolean }
  | { t: "gate"; action: "sendFeedback" | "approve" }
  | { t: "viewState"; state: PersistedViewState }
  | { t: "align" }
  | { t: "export"; format: "mermaid" | "d2" | "json"; view: ViewId };
```

- The host checks every incoming message with zod at the boundary, as #74 does.
- `layer` arrives when `agent.json` passes a check, or when a producer finishes late. The webview merges it and lays out again only the views that change.
- `delta` arrives when the working tree changes. A delta change does not change the graph shape, so layout often stays the same.
- The comment messages come from #77, with `VizRef` in place of `typeId` and `memberId`.

## 3. Comments on diagram elements

A diagram comment is a `ReviewThread`, as in #77. The change is the anchor.

```ts
interface DiagramAnchor {
  viz: string;
  view: ViewId;
  title: string;
  targets: DiagramTarget[];
  place?: NotePlace;
  readAt?: string;
}

interface DiagramTarget {
  ref: VizRef;
  label: string;
  code?: { ref: CodeRef; anchor: ReviewAnchor };
}

interface NotePlace { ref?: VizRef; x: number; y: number }
```

- Each target keeps a `ReviewAnchor` (line text and context) next to its `CodeRef`. When the code moves, `relocateReviewAnchor` finds the new line. #77 stores a fixed `file:line` copy.
- If the element id is gone after a refresh, the thread still has its code anchor. The note shows as orphaned on the diagram, and it still opens the code. This uses the same idea as `orphanComments.ts`.
- The agent receives the thread through the normal feedback text. Each target renders as `- <label> (<kind>) at <path>:<line>`, plus the element id, so the agent can find it in `generated.json` or `agent.json`.

```mermaid
sequenceDiagram
  autonumber
  actor User
  participant View as Webview
  participant Host as VizService
  participant RC as ReviewController
  participant FS as FeedbackSession
  participant Agent

  User->>View: Right-click element, Add comment
  View->>Host: comment.add(anchor with refs, body)
  Host->>Host: Resolve each ref to CodeRef and ReviewAnchor
  Host->>RC: addDiagramComment(anchor, body)
  RC->>FS: Add pending thread
  FS-->>Host: threads changed
  Host->>View: threads(summary)
  User->>View: Send Feedback
  View->>Host: gate(sendFeedback)
  Host->>FS: Send pending threads
  FS->>Agent: Feedback text with targets, paths, lines, ids
  Agent->>FS: Reply in thread
  FS-->>Host: threads changed
  Host->>View: threads(summary, unread)
  View-->>User: Note shows the reply
```

## 4. Code snippets

The webview asks for a snippet when the user hovers or selects an element. The host reads the text through the same document providers that the diff view uses, so both sides work.

```ts
interface Snippet {
  code: CodeRef;
  language: string;
  startLine: number;
  lines: string[];
  highlight?: { start: number; end: number };
  changes?: { line: number; kind: "added" | "removed" }[];
}
```

- `side: "base"` reads through the `paireto-review:` URI. `side: "modified"` reads the working file.
- `changes` marks added and removed lines, so the preview can show a small inline diff.
- Syntax colours are a webview concern. A library such as Shiki can run in the webview with the VS Code theme colours. This is an open choice.
- The host caches snippets by content id, as #77 caches symbols.

## Exporters

Export is one-way. No Mermaid import. Mermaid has no official parser AST for flowchart, sequence or class diagrams, so import would be a separate project.

| View kind | Mermaid | What is lost |
| --- | --- | --- |
| `graph` | `flowchart` with `subgraph` for parents | Members, evidence, code refs, roles |
| `class` | `classDiagram` with members and UML arrows | Delta detail, code refs |
| `sequence` | `sequenceDiagram` with `alt / opt / loop / par` | Request and response bodies, code refs |

- Delta shows as a prefix glyph and a `classDef` colour.
- The JSON export is the full `VizDoc`. It is the only lossless format.
- D2 is the second exporter. It keeps deep nesting and sequences with less loss than Mermaid.

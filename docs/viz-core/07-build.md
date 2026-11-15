# Shared viz core: build plan

This plan replaces the layer design in [02-architecture.md](02-architecture.md) to [04-protocols.md](04-protocols.md) with a simpler first release. The other documents stay as background.

## Scope

- One file for each viz, `.paireto/viz/<name>.viz.json`. The schema is `VizFile` in `src/protocol/viz.ts`.
- There are no layers. `paireto_viz_generate` writes the file, and the agent then edits the same file.
- ReactFlow renders every view.
- Named components. The node `kind` picks the component:
  - `class`, `interface`, `enum`, `struct`, `module` and `file` draw a UML class box with members.
  - `package` and `system` draw a frame around child nodes.
  - The other kinds draw an architecture card.
  - A flow draws as a sequence diagram with lifelines, activations, phases and fragments.
- MCP tools:
  - `paireto_viz_generate(name, base, title?)` writes the file and returns its path. With `base: "changes"`, Paireto builds class nodes from the Compare To diff with the symbol providers. With `base: "none"`, Paireto writes an empty skeleton. The result text includes the change summary that `paireto_get_changes` returned in #74.
  - `paireto_viz_present(name)` checks the file and opens it for the user. It returns errors with JSON paths.
  - `paireto_show_viz` and `paireto_get_changes` go.
- The `paireto-viz` skill teaches the agent the two tools and the schema, and when to use each base.
- One viz UI. It has the look of #77 and the features of #74:
  - From #77: the look, class boxes with change badges and line counts, the toolbar (Show, Filter, View, Find), the review list (seen files, Next change), and notes as review threads with Send Feedback.
  - From #74: flows with playback, the walkthrough, the inspector, focus, search, keyboard help, Mermaid export, and the Compare To mismatch badge with Align.
  - New: the viz switcher, and "Ask agent to regenerate" when the window's Compare To differs from the viz's.
- A `.viz.json` file opens in the viz custom editor by default. The viz button on the Changed Files row opens the newest viz.
- Paireto does not change `.gitignore`.

## Units

Each unit ends with type checks, lint, format and the unit suite green in Docker.

| Unit | Owns | Depends on |
| --- | --- | --- |
| U1 Model | `src/protocol/viz.ts`, `src/viz/model/{compile,index,refs,render,mermaid,types}.ts` and their tests. Minimal changes elsewhere so the project compiles | Schema |
| U2 Generator | `src/viz/generate/`: symbol extraction, outline, signatures, relations, file diff and line diff ported from #77, and `generateViz()` that returns a `VizFile` | U1 |
| U3 Host | `src/viz/host/`, `src/plugins/**` tools and skills, `src/review/` diagram comments, `src/extension.ts`, `package.json` contributions, emulator scripts | U1 |
| U4 Webview | `src/viz/webview/`, `src/viz/layout/`, `src/viz/model/{rf,ui,emphasis,keymap}.ts` | U1 |
| U5 Integration | Merge U2 to U4, wire the generator into the host, record e2e cassettes, verify in the preview and in VS Code, update the docs | U2, U3, U4 |

U2, U3 and U4 run in parallel in separate worktrees, because their files do not overlap. The host and webview message types in `src/viz/protocol.ts` are fixed in U1, so U3 and U4 agree on them.

## Done means

1. `pnpm check-types`, `pnpm lint` and `pnpm format` pass.
2. The unit suite passes in Docker. The baseline before this work is 1291 passing, 0 failing.
3. The e2e suite passes in Docker against cassettes recorded for the new tools.
4. In the browser preview, a generated fixture viz shows class boxes with members and badges, a sequence flow with a fragment, notes, and the review list.
5. In VS Code, `paireto_viz_generate` on a real diff writes a file with class nodes, and `paireto_viz_present` opens it. A note on a class becomes a review thread that Send Feedback delivers.

## Status

| Unit | Result |
| --- | --- |
| U1 Model | Done. `VizFile` schema, compile rules, index, refs, Mermaid flowchart, class and sequence exports |
| U2 Generator | Done. `src/viz/generate/`. Ported from #77. Uses a definition lookup when a short type name is ambiguous |
| U3 Host | Done. Viz files, `paireto_viz_generate`, `paireto_viz_present`, custom editor, Open Viz, open newest, notes as review threads, regenerate request, skill for every harness, wire version 0.12.0 |
| U4 Webview | Done. One ReactFlow UI with #77's look and #74's features. ELK runs on the main thread, because the webview CSP has no `worker-src`. It takes 53 ms for the class diagram fixture |
| U5 Integration | Done. Generator connected. Cassettes recorded again for codex, kiro, opencode and pi. OpenCode now runs with `OPENCODE_DISABLE_MODELS_FETCH`, so record and replay send the same title request |

Verified:

- The unit suite passes in Docker: 1423 passing, 0 failing.
- The e2e suite passes in Docker against the recorded cassettes: 15 suites over five harnesses.
- A real TypeScript language server in the VS Code test host produces class nodes, members and edges that compile with no errors.
- `vscode.open` on a `.viz.json` file opens the viz editor.
- The webview renders under the editor's Content Security Policy in headless Chrome, with no violations.

Not yet verified by hand: the full agent loop in a live VS Code window. No e2e case drives the viz tools.

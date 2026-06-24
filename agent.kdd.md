# TUI Companion — Key Decisions

- **Agent process-death is detected via an MCP liveness socket, not a PID.** Claude Code exposes no
  agent PID to hooks/MCP, and `SessionEnd` doesn't fire on SIGKILL/terminal-close. But the plugin's
  stdio MCP server (`plugins/claude-code/mcp/server.js`) is a session-lifetime process (started at
  session init for `tools/list`, killed with Claude) and receives `CLAUDE_CODE_SESSION_ID` in its
  env. So at startup it opens a socket, sends `session.attach` `{sessionId}`, and **holds it open**.
  `SocketServer.handleConnection` remembers that connection's `sessionId` and calls
  `onSessionAttached`/`onSessionDetached`; `AgentSessionService` **ref-counts** liveness connections
  per session and `removeSession`s only when the last one drops (so a second connection — e.g. the
  emulator alongside the real MCP — doesn't drop the row prematurely). This is OS-level and more
  reliable than polling a PID (UDS close fires on peer death).
  Distinguish from a gate *interrupt*: dropping the blocking plan/review connection (Esc) →
  `markIdleOnDisconnect` (agent still alive); dropping the liveness connection → `removeSession`. If
  only the MCP server crashes (agent alive), the row is re-created by the next telemetry event. Every
  emulator command runs through one `withBridge` golden path (resolve → connect → optional session
  announce + liveness attach → body → teardown), so the lifecycle can't drift per-command (it's how
  `plan`/`review` once missed the attach). Commands flagged `live` (`agent`/`plan`/`review`) hold the
  attach, so Ctrl+C (fully quitting any of them) simulates a process kill and drops the agent;
  `doctor`/`event`/`flow` are probes with no attach.

- **Changed-file status indicators are coloured-letter SVGs (left iconPath), not FileDecorations.**
  We want git's look: a coloured status letter with a *default-coloured* filename. The generic
  `FileDecorationProvider` API (all a custom `TreeView` can use) tints the whole label+badge together
  — there's no badge-only colour; only VS Code's built-in **Source Control viewlet** (the `vscode.scm`
  API) renders a letter-only colour, and that's not available to a TreeView. A `TreeItem` also has no
  right-aligned icon slot. So `MainTreeProvider.fileItem` sets `iconPath` to a per-status SVG
  (`media/status/{a,m,d,r,c,u}-{light,dark}.svg`) that bakes the git colour into a letter glyph —
  tree iconPath SVGs render as-is (not theme-tinted), hence the light/dark variants (git default
  hexes). The old `ReviewFileDecorationProvider` + `tui-review-file` scheme were removed. Tradeoff:
  the indicator is a left letter, not a right-aligned one, and rows show the status letter instead of
  a file-type icon (a real-file `resourceUri` would re-introduce git's own label colouring).

- **Plan/Review gates are a foreground registry, not a hard one-at-a-time lock.** The
  `GateCoordinator` (`src/gate/GateCoordinator.ts`) holds many pending `GateEntry`s but only one
  *foreground* (it owns the editor/comment surfaces and is `coordinator.current`, the target of the
  shared Approve/Send-Feedback commands). `register` foregrounds only if nothing else is; `switchTo`
  backgrounds the current entry (hides its UI **without resolving** — e.g. closes the plan tab) and
  foregrounds another; `unregister` (on resolve) promotes the most-recent remaining entry. The
  bottom panel is hidden while any gate (plan or review) is foreground, restored when none is (hooks are
  injectable so the coordinator stays unit-testable). **Multiple plans** can be pending (each is its
  own `tui-plan://` doc + URI-anchored threads, so backgrounding just closes the tab and preserves
  comments); **at most one review** is pending (`ReviewController` has an internal queue — a second
  `/tui-review` waits) to avoid two reviews colliding on the same `tui-review://` diff-URI namespace.
  Clicking an agent row (`MainTreeProvider` → `tui-companion.agent.switch`) calls `switchTo` its
  gate. The Agents section is scoped to the current repo (`sessionsForRepo`). Reviews carry no
  reliable `sessionId`, so the extension attributes a review to the most-recently-active session in
  its `repoRoot` (`AgentSessionService.mostRecentSessionForRepo`) when the MCP tool can't supply one.
  This refined the earlier strict block: a queued gate is no longer invisible — it's pending and
  switchable.

- **Plan and Review share one gate model.** `PlanReviewController` and `ReviewController` register a
  per-gate `GateEntry` carrying its own `GateSession` (`{kind, approve, sendFeedback}`) rather than
  implementing `GateSession` directly. The shared `gate.approve` / `gate.sendFeedback` commands
  dispatch to `coordinator.current`. There is no Reject (Send Feedback covers it) and review's
  "Approve" is the old cancel path (proceed, no feedback). Inline comments are factored into a shared
  `CommentSession` (`src/comments/CommentSession.ts`) with global, controller-agnostic
  edit/save/delete commands operating on a `GateComment` (its `contextValue` flips preview↔editing to
  gate the comment menus).

- **A dropped socket connection resets gate state.** `SocketServer.handleConnection` wraps each
  blocking `plan.review.request` / `review.await.request` in an `AbortController` and aborts it on
  `socket.on("close")`; the signal threads through `BridgeHandlers` into `presentPlan` /
  `startSession`, which fulfill their gate and reset (dispose comments, close the plan tab,
  `coordinator.unregister` to promote the next pending gate). This is the single mechanism behind
  "close the plan when ExitPlanMode completes in the agent" and "reset on any closed connection." The
  plan tab also auto-closes on a normal decision; our own programmatic closes are tracked in a
  `closingTabs` set so they don't trip the early-close prompt, while a user closing a still-pending
  plan tab is prompted for Approve / Send Feedback. The abort also resets the owning **agent session**
  to idle (`AgentSessionService.markIdleOnDisconnect`, wired on the signal in the `extension.ts`
  bridge handlers) — there's no Stop hook on an interrupt, so otherwise the Agents indicator stays
  stuck on "awaiting plan review" (never stale-swept) or "thinking" (until the 120s sweep). (The
  virtual-doc-in-search item is verification-driven — auto-close/reset removes lingering virtual
  editors; confirm in the dev host before adding any further suppression.)

- **Plugin TS dev scripts get their own tsconfig.** `plugins/claude-code/scripts/*.ts` (e.g. the
  bridge emulator) run directly on Node's type-stripping and live outside the extension's
  `rootDir: "src"`. They're type-checked via `plugins/claude-code/tsconfig.json` (noEmit), which
  `check-types` runs after the root build. Don't add `plugins` to the root tsconfig `include` —
  it breaks `compile-tests`' `out/` layout (the test runner globs `out/test/**`).

- **Editable diffs use the real working-tree file as the modified side.** That gives LSP + editing
  for free and routes edits to the unstaged (lowest) level. A file is editable only when it has no
  change at a lower level (committed > staged > unstaged) and isn't deleted. Tree groups are ordered
  top-down by layer (Committed, Staged, Working Tree); the unstaged group is labelled "Working Tree".

- **The `tui-review` virtual scheme is a READ-ONLY `FileSystemProvider`, not a
  `TextDocumentContentProvider`.** A content-provider doc placed on a diff's *modified* (right) side
  stays editable-in-buffer — you can type into it and Save just prompts "Save As" — so read-only diffs
  weren't actually read-only. Registering the scheme via `registerFileSystemProvider(..., {isReadonly:
  true})` (with `stat` returning `FilePermission.Readonly`) makes those docs genuinely non-editable.
  `readFile`/`stat` resolve git content (cached per-URI, cleared on change); refreshes fire
  `onDidChangeFile` Changed events. Editable diffs are unaffected: their modified side is a real
  `file://` doc, only the base side is `tui-review` (correctly read-only).

- **Editability is decided once in `openDiff`, against `this.changes`.** `file://` modified =
  editable; `tui-review` modified = read-only. This is reliable because the model is kept honest:
  `collect` uses throwing `git` for name-status and `refresh()` keeps the last-good model on git error
  (never blanks → no spurious "no changes"); the first `refresh()` runs *after* `repoService.init()`;
  `refreshSeq` discards stale results. No self-repair/reconcile pass and no `loaded` gate — those were
  scaffolding from before we found the real bug (the editable virtual scheme) and never actually fixed
  it (the failing case logged `editable=false`). Accepted edge: a restored-from-last-session editable
  tab, or a staged diff left open while its file later gains a lower-layer change, won't auto-flip to
  read-only. Diffs stay virtual (`tui-review` scheme) during a `/tui-review` session because the
  comment controller only attaches
  to that scheme — editing and commenting can't share a diff side. The first edit to a
  staged/committed editable diff (detected via `onDidChangeTextDocument` + the active
  `TabInputTextDiff`) "demotes" its base **in place**: `ReviewContentProvider` keeps a per-path
  `demoted` set and serves the index for those base sides, then fires `onDidChange` on the open base
  URI so VS Code re-renders just the left side against the live dirty buffer. No reopen/close, so no
  save prompt and caret/focus are untouched (this replaced an earlier reopen+`tabGroups.close`
  approach that prompted to save and needed `setTimeout` caret restoration). Demotions clear on a
  fresh `openDiff(path)`, on Compare-To change, and on repo switch; editable diffs are titled
  "(Working Tree)" since the base shifts. Demotions are also pruned when a diff tab closes
  (`tabGroups.onDidChangeTabs` → `pruneClosedDemotions`) — never by "no longer unstaged", which would
  wrongly un-demote a file being edited before its first save.

- **Diffs stay in sync with git via one funnel: `refresh()` always calls
  `ReviewContentProvider.refreshAllOpen()`.** The bug was that UI stage/unstage/discard refreshed the
  tree but not the open diff's virtual sides, so VS Code served a stale cached `git show :path`/`HEAD`
  blob. `refresh()` re-fires `onDidChange` for all open `tui-review` URIs (after the `refreshSeq`
  supersede guard, even when the `changesEqual` tree guard skips re-render — content can change without
  the file-list summary changing). **Do NOT add a custom `**/*` FileSystemWatcher** — an earlier one
  spawned a full `getChanges` on every working-tree event (e.g. `.vscode/settings.json` autosave
  churn) and pinned the CPU. The VS Code git extension already watches the working tree + git dir
  efficiently and fires `RepoService.onDidChange` on real status changes (working/index/HEAD,
  including external terminal `git add`/commit) — that is the sole sync trigger, wired in
  `extension.ts` to `reviewController.refresh("git")`. UI git ops also call `refresh()` directly;
  in-buffer (pre-save) edits are handled by the demotion path. `refreshSeq` discards a stale in-flight
  `getChanges`; `changesEqual` skips redundant tree renders; demotions clear on repo-root change. Set
  `tui-companion.debug` to log refresh/openDiff decisions to the "TUI Companion" channel.

- **Folder rows reuse the file stage/unstage/discard commands.** Tree folders carry their
  `FileGroup` so the contextValue is `folder:<group>`; the command handlers flatten a folder node to
  all descendant files (`filesInEntry`). Committed folders/files are read-only (no git buttons).

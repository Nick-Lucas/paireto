# TUI Companion — Key Decisions

- **Agent process-death is detected via an MCP liveness socket, not a PID.** Claude exposes no agent
  PID and `SessionEnd` doesn't fire on kill, so the MCP server holds a socket open; its drop →
  `removeSession` (ref-counted so layered connections don't drop the row early). A gate interrupt
  (Esc) drops a different connection → `markIdleOnDisconnect`.

- **"Agent finished" = entering a needs-you state** (stopped / awaiting permission / awaiting plan)
  **or a `Notification`** (Claude's "waiting for input" — covers question prompts that never reach a
  needs-you state), detected on the edge in `AgentSessionService.ingest` → `onDidFinish`. Suppressed
  when this window is focused (no point nagging); cleared when a new turn starts. Drives
  `needsAttention`.

- **Subagent status is never tracked — global bailout at the top of `ingest`.** Any hook event
  carrying an `agentId` returns immediately (never creates/touches/states/pings the parent row). There
  is no subagent counter: the `Subagent*` hooks are unsubscribed and surfaces show only the top-level
  agent's general state.

- **The needs-you cue is visual + optional sound, never an OS push notification.** osascript banners
  are silently dropped and `alerter`/AXRaise needed extra installs + Accessibility — not worth it. So
  just a sound (`NotificationController`, `notify.type` = sound|disabled) plus an orange bell in the
  sidebar, status bar, and switcher.

- **Cross-window agent activity travels through per-repo files** (`$STATE/activity/<repoKey>.json`),
  since VS Code has no cross-window API. Each window publishes its own; the switcher reads them +
  `index.json` (`repoSnapshots`) to show other repos' state and whether a window is open.

- **The switcher's orange bell is a baked SVG, not a `ThemeIcon`+`ThemeColor`** — a QuickPick ignores
  the colour on an iconPath ThemeIcon (trees honour it, which is why the sidebar bell can stay one).

- **Changed-file status indicators are coloured-letter SVGs (left iconPath), not FileDecorations** —
  a FileDecoration tints the whole label; the letter-only colour git uses is SCM-viewlet-only, not
  available to a TreeView. Tradeoff: left letter instead of a right-aligned one, no file-type icon.

- **Plan/Review gates are a foreground registry (`GateCoordinator`), not a hard one-at-a-time lock.**
  Many gates pending, one foreground (owns the editor/comment surfaces); clicking an agent `switchTo`s
  its gate. Multiple plans can pend; at most one review (avoids `tui-review://` URI collisions).

- **Plan and Review share one gate model** — each registers a `GateEntry`/`GateSession`; shared
  `gate.approve`/`gate.sendFeedback` dispatch to the foreground. No Reject (Send Feedback covers it);
  inline comments are a shared `CommentSession`.

- **A dropped socket connection resets gate state.** Each blocking request gets an `AbortController`
  aborted on socket close → fulfill the gate, reset UI, and `markIdleOnDisconnect` the agent (there's
  no Stop hook on an interrupt). This is the one mechanism behind "ExitPlanMode resolved elsewhere".

- **The bottom panel is hidden while any gate is foreground, restored when none is** (in
  `GateCoordinator`; panel hooks injectable so it stays unit-testable).

- **Plugin TS dev scripts get their own tsconfig** (`plugins/claude-code/tsconfig.json`) — they run
  on Node type-stripping outside `rootDir: src`. Don't add `plugins` to the root tsconfig; it breaks
  the test runner's `out/` layout.

- **Editable diffs use the real working-tree file as the modified side** — gives LSP + editing for
  free and routes edits to the unstaged level. Editable only when there's no change at a lower layer
  (committed > staged > unstaged) and the file isn't deleted.

- **The `tui-review` virtual scheme is a READ-ONLY `FileSystemProvider`, not a
  `TextDocumentContentProvider`** — a content-provider doc on a diff's modified side stays
  editable-in-buffer (Save → "Save As"), so it wasn't actually read-only.

- **A staged/committed diff's first edit "demotes" its base to the index in place** — fire
  `onDidChange` on the open base URI rather than reopening, so there's no save prompt and caret/focus
  survive. Demotions clear on re-open, Compare-To change, repo switch, and tab close.

- **Diffs sync with git via one funnel: `refresh()` → `ReviewContentProvider.refreshAllOpen()`.** Do
  NOT add a custom `**/*` FileSystemWatcher (an earlier one pinned the CPU on autosave churn) — the
  VS Code git extension's `onDidChange` is the sole sync trigger. `tui-companion.debug` logs decisions.

- **Folder rows reuse the file stage/unstage/discard commands** — a folder's `contextValue` is
  `folder:<group>` and handlers flatten it to descendant files. Committed rows are read-only.

- **Agent rows are labelled `Claude (<short id>)`** (harness name + `sessionId.slice(0,8)`), not the
  repo basename — the basename was identical for every agent in a repo; repo/start-time/tool live in
  the tooltip.

- **Comment author = signed-in account → OS user → "Developer"** (`comments/author.ts`, cached; the VS
  Code `authentication.getSession` lookup is async+silent so it's resolved once at activation).

- **Approving a plan defaults the agent into `auto` mode** via the PermissionRequest decision's
  `updatedPermissions: [{type:"setMode", mode}]` (Claude otherwise restores the pre-plan mode).
  Overridable by `tui-companion.planApprove.mode` (`off` = leave unchanged).

- **Staging/unstaging/discarding re-points an open diff tab** to the file's new git layer
  (`reconcileOpenDiffsAfterWrite`: close+reopen at the new group, or close if the change is gone).

- **One gate button shows at a time, via `tui.gateHasFeedback`** — set from the foreground gate's
  `hasFeedback()`; `when` clauses show Approve before any feedback, Send Feedback once there is some.

- **Commenting on Changes diffs is always on; the first comment auto-starts a "deferred" review.**
  Comments anchor on the review-scheme side of a locked diff OR the editable working-tree (file:) side
  of an editable one — so commenting works in both cases.

- **Editability is purely structural and session-independent** (`isFileEditable`): editable iff the
  file isn't deleted and has no change at a lower git layer. A review never forces a diff read-only;
  reconcile/stage-unstage leaves a file alone once it has a comment (`hasCommentOnPath`).

- **A blocking `Stop` hook delivers deferred-review feedback at turn-end** (`on-review-gate.js` +
  `awaitStopOutcome`). It only enters review mode when the turn touched files (edit-class PostToolUse /
  FileChanged; backup: any uncommitted change), waits for the user, and **never auto-submits** —
  feedback reaches the agent only via an explicit Send Feedback. Fails open instantly otherwise.

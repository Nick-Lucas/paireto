# Paireto — Key Decisions

- **The Welcome screen is the only webview** (everything else is tree/virtual-doc/comments). Shown
  once on first install via the `paireto.welcomeShownVersion` globalState marker (a version string, so
  a bump can re-show), reopenable via `paireto.openWelcome`. **Setup is now Welcome-only — there is no
  activation-time plugin auto-install** (removed with the `paireto.plugin.autoInstall` setting).

- **The Welcome webview is React/TSX**, bundled by a second esbuild build (browser/iife →
  `dist/welcome.js`, shipped via a `!dist/welcome.js` line in `.vscodeignore`). It has its own
  `src/welcome/webview/tsconfig.json` (DOM lib + `jsx`), excluded from the root tsconfig so DOM globals
  don't leak into the node host; `check-types` runs it as a third project. Styles live in a colocated
  `welcome.css` imported from the entry — esbuild emits a sibling `dist/welcome.css` (also `!`-listed)
  loaded via `<link>` (CSP `style-src` is just `cspSource`, scripts stay nonce-locked). Host↔webview
  share type-only contracts in `src/welcome/protocol.ts`. oxlint gains the `react` plugin.

- **Logging goes through one shared logger (`src/log.ts`, `log.error/info/debug`), gated on
  `paireto.logLevel`** (`off`/`error`/`info`/`debug`, default `info`; replaces the old boolean
  `paireto.debug`). Most diagnostics are `info`; big-JSON dumps (e.g. keybinding-match objects) are
  `debug`. `logLevel` only controls whether lines are *written* — never call `OutputChannel.show()`
  (it force-reveals the Output panel / "bottom bar") and never gate UI/layout/flow on it.

- **Terminal-profile setup is a separate per-agent action** (its own nested row + **Configure** button
  with ✓ Configured / Not configured status), decoupled from plugin install. Writes
  `terminal.integrated.profiles.<osx|linux|windows>` (e.g. `claudecode` → `<vscode.env.shell> -l -c
  claude`) to global settings; leaves an existing profile of the same name untouched. Powers the
  quick-launch `newWithProfile` keybinding.

- **The Welcome "Paireto way" section manages built-in VS Code keybindings by editing the user's
  `keybindings.json`** — VS Code exposes no read/write API (no lookup-by-command-id), so we read user
  overrides from the file and fall back to a small hardcoded **known-defaults table** for the commands
  we manage (that's how `cmd+shift+[`/`]` terminal-tab defaults register as already-set). Located via
  `globalStorageUri` two dirs up (`<userData>/User/keybindings.json`); written with `jsonc-parser` so
  comments survive. No gate Approve/Feedback bindings.

- **Applying a shortcut can also write `-command` removals** (`ManagedShortcut.removeDefaults` →
  `applyShortcut`): some keys carry a conflicting default that must be cleared (quick-launch =
  `terminal.newWithProfile` removes the default `terminal.new` off `ctrl+shift+\``; fullscreen removes
  `zoomIn` off `shift+cmd+=`). `isApplied` requires the positive binding *and* every removal, so a
  half-applied state still shows "Set".

- **`vsce package` runs with `--no-dependencies`.** esbuild bundles all runtime deps (e.g. `dedent`)
  into `dist/extension.js`, so there's nothing to enumerate — and vsce's default `npm list` step
  fails anyway under pnpm.

- **`.vscodeignore` is an allowlist (`**` then `!`-include).** Ships only `dist/extension.js`,
  `media/**`, `package.json`, `README`/`LICENSE`/`CHANGELOG`, and the whole `plugins/**` tree. Re-includes are
  case-sensitive (`CHANGELOG.md`, not `changelog.md`) and name `dist/extension.js` exactly so stray
  dist artifacts never ship. vsce applies `!` negations LAST as a global override — you can't
  re-exclude a subset of a negated tree, so `plugins/` must contain only shippable files.

- **`plugins/` contains ONLY the distributed plugin artifact; dev tooling lives in repo-root
  `scripts/`.** So `!plugins/**` ships the folder verbatim with no per-file filtering. The emulator
  (`scripts/emulator.ts`) `require()`s the plugin's `bridge.js` across the tree.

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
  its gate. Multiple plans can pend; at most one review (avoids `paireto-review://` URI collisions).

- **Plan and Review share one gate model** — each registers a `GateEntry`/`GateSession`; shared
  `gate.approve`/`gate.sendFeedback` dispatch to the foreground. No Reject (Send Feedback covers it);
  inline comments are a shared `CommentSession`.

- **A dropped socket connection resets gate state.** Each blocking request gets an `AbortController`
  aborted on socket close → fulfill the gate, reset UI, and `markIdleOnDisconnect` the agent (there's
  no Stop hook on an interrupt). This is the one mechanism behind "ExitPlanMode resolved elsewhere".

- **The bottom panel is hidden while any gate is foreground, restored when none is** (in
  `GateCoordinator`; panel hooks injectable so it stays unit-testable).

- **TS dev scripts get their own tsconfig** (`scripts/tsconfig.json`) — they run on Node
  type-stripping outside `rootDir: src`. Don't add `scripts`/`plugins` to the root tsconfig
  (`include: ["src"]`); it breaks the test runner's `out/` layout. `check-types` runs `tsc -p scripts`
  alongside the root.

- **Editable diffs use the real working-tree file as the modified side** — gives LSP + editing for
  free and routes edits to the unstaged level. Editable only when there's no change at a lower layer
  (committed > staged > unstaged) and the file isn't deleted.

- **The `paireto-review` virtual scheme is a READ-ONLY `FileSystemProvider`, not a
  `TextDocumentContentProvider`** — a content-provider doc on a diff's modified side stays
  editable-in-buffer (Save → "Save As"), so it wasn't actually read-only.

- **Diffs/Open File support ANY file type (images, etc.), like the git panel.** The review provider
  serves raw bytes (`gitSafeBytes` + binary `fs.readFile`, never a UTF-8 round-trip that mangles
  binary blobs); "Open File" uses `vscode.open` (not `showTextDocument`) so VS Code picks the editor;
  the editable-diff TextDocument pre-open (for TS LSP) is skipped for binary files (`isTextFile`
  NUL-byte check) so it doesn't defeat the image diff.

- **Adds/deletes open a SINGLE editor, not a two-pane diff** (`singlePaneSide`): one side is empty, so
  a diff would render a broken/empty pane (an image viewer can't show the 0-byte side). Add → show the
  modified side; delete → show the base. Both panes still match the comment controller (file: side or
  paireto-review side), so they stay commentable.

- **A staged/committed diff's first edit "demotes" its base to the index in place** — fire
  `onDidChange` on the open base URI rather than reopening, so there's no save prompt and caret/focus
  survive. Demotions clear on re-open, Compare-To change, repo switch, and tab close.

- **Diffs sync with git via one funnel: `refresh()` → `ReviewContentProvider.refreshAllOpen()`.** Do
  NOT add a custom `**/*` FileSystemWatcher (an earlier one pinned the CPU on autosave churn) — the
  VS Code git extension's `onDidChange` is the sole sync trigger. `log.info` records decisions.

- **Folder rows reuse the file stage/unstage/discard commands** — a folder's `contextValue` is
  `folder:<group>` and handlers flatten it to descendant files. Committed rows are read-only.

- **Agent rows are labelled `Claude (<short id>)`** (harness name + `sessionId.slice(0,8)`), not the
  repo basename — the basename was identical for every agent in a repo; repo/start-time/tool live in
  the tooltip.

- **Comment author = signed-in account → OS user → "Developer"** (`comments/author.ts`, cached; the VS
  Code `authentication.getSession` lookup is async+silent so it's resolved once at activation).

- **Approving a plan defaults the agent into `auto` mode** via the PermissionRequest decision's
  `updatedPermissions: [{type:"setMode", mode}]` (Claude otherwise restores the pre-plan mode).
  Overridable by `paireto.planApprove.mode`, a per-harness object (`{ "claudecode": "auto" }`) so
  future harnesses get their own value (`off` = leave unchanged).

- **Turn-end auto-review is gated by `paireto.review.mode`** (`automatic` default / `manual`): in
  `manual`, `shouldOpenTurnEndReview` ignores `changedThisTurn`, so only queued comments or
  `/paireto-review` open a review. Comment-driven and manual review are unaffected.

- **Plan-gate failure behavior is canonical and inlined, not configured** — the `planGate.*` settings
  AND the whole config-mirror plumbing (`config.json`, `ConfigMirror`, `BridgeConfig`,
  `bridge.loadConfig`) were removed. `on-plan-gate.js` hardcodes it directly: no window → allow
  (fail-open), timeout/malformed/dropped → defer to the native prompt (fail-visible), ~4-day timeout.

- **Staging/unstaging/discarding re-points an open diff tab** to the file's new git layer
  (`reconcileOpenDiffsAfterWrite`: close+reopen at the new group, or close if the change is gone).

- **One gate button shows at a time, via `paireto.gateHasFeedback`** — set from the foreground gate's
  `hasFeedback()`; `when` clauses show Approve before any feedback, Send Feedback once there is some.

- **Commenting on Changes diffs is always on; comments accumulate in an unclaimed "bucket"
  (`this.comments`), they do NOT start a review.** A review (started by /paireto-review or the turn-end
  gate) simply consumes whatever is in the bucket; resolving it clears the bucket. Comments anchor on
  the review-scheme side of a locked diff OR the editable working-tree (file:) side of an editable one,
  so commenting works in both cases.

- **Editability is purely structural and session-independent** (`isFileEditable`): editable iff the
  file isn't deleted and has no change at a lower git layer. A review never forces a diff read-only;
  reconcile/stage-unstage leaves a file alone once it has a comment (`hasCommentOnPath`).

- **The activity-bar badge is the changed-file count only.** VS Code's `ViewBadge` is numeric and
  theme-coloured — no per-view colour or icon API — so it can't carry a distinct "bell". The badge is
  just the count (like the Git tab; partially-staged files counted per-section, not deduped); agent
  needs-you cues live on the colourable surfaces (status bar, agent rows, switcher).

- **One review path, two entry points** (`runReview`): both `startSession` (/paireto-review) and
  `awaitStopOutcome` (the turn-end `Stop` hook, `on-review-gate.js`) register a gate, block on
  `this.gate`, then map the one `ReviewGateResult` to their reply (socket result vs Stop block/allow).
  No separate "deferred review" type, no adoption/claiming — a starting review just consumes the
  comment bucket. `awaitStopOutcome` (`shouldOpenTurnEndReview`) opens a review only when **this
  agent's turn edited files** — detected via the `PostToolUse` edit-tool hook (`changedThisTurn`), NOT
  the repo's overall uncommitted state — or the comment bucket is non-empty; otherwise it allows the
  stop. **Never auto-submits** — feedback reaches the agent only via an explicit Send Feedback. Fails
  open instantly otherwise.

- **At most one review at a time, via the slot (`reviewBusy` + `reviewWaiters`).** `startSession`
  acquires the slot, queuing behind any in-progress review; the turn-end gate just allows the stop if
  the slot is busy. `cleanupReview` releases it. The dead `ReviewComment.resolved` flag was removed.

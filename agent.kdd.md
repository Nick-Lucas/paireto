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
  (it force-reveals the Output panel / "bottom bar") and never gate UI/layout/flow on it. Every line
  gets a compact `MM/dd HH:mm:ss` local timestamp prefix (`Logger.write`), and every plan/review gate
  open and resolve (approve/send-feedback) logs at `info` with who and why — the routine "nothing to
  review, allow the stop" turn-end case stays at `debug` since it fires on every turn.

- **Terminal-profile setup is a separate per-agent action** (its own nested row + **Configure** button
  with ✓ Configured / Not configured status), decoupled from plugin install. Writes
  `terminal.integrated.profiles.<osx|linux|windows>` (e.g. `claudecode` → `<vscode.env.shell> -l -c
  claude`) to global settings; leaves an existing profile of the same name untouched. Powers the
  quick-launch `newWithProfile` keybinding.

- **Per-agent install status is a tri-state from a version-stamp file** (`<globalStorage>/adapters/
  <id>/installed-version`): absent → not-installed, equal → installed, stale → update-available. No
  migration from the old `paireto.pluginInstalledVersion` globalState marker — pre-stamp installs
  just show "Set up" once more (install is idempotent).

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

- **`PluginInstaller.installPlugin` repoints a stale marketplace registration before re-adding it,
  and the installed-version marker reads `plugin.json` directly** (`readPluginVersion`, no try/catch
  — the manifest ships with the extension, so a missing/malformed file is a packaging bug that should
  crash loudly, not a runtime condition to swallow — but it does explicitly assert the parsed JSON has
  a string `version` field rather than blindly trust-casting, so the error points straight at the
  manifest instead of surfacing later as a confusing downstream failure) instead of a second
  hardcoded constant. Two
  enabled marketplaces shipping the same plugin double-fires every hook (a plan approval only
  resolves one of the two pending `plan.review.request`s, so Claude Code never fully unblocks) — this
  happens whenever the extension's install path moves (VSIX upgrade, switching installed-extension
  vs. dev-mode) and the old idempotency check (`isAlreadyPresent`) never verified the
  already-registered source still matched. `claude plugin marketplace list --json` is the check; a
  mismatch triggers `remove` before `add`, logging at info either way (repointed, or removal failed
  with the CLI's error) so a still-stuck registration is traceable. This doesn't merge two
  *differently-named* marketplaces already pointing at the same plugin — that's a one-time manual
  `claude plugin marketplace remove <stale-name>` cleanup.

- **One name, one value, one point of truth for the whole plugin bundle's version: `PLUGIN_VERSION`,
  imported straight from `plugin.json`.** Before this there were four independently-drifting version
  strings (a bare-integer wire `PROTOCOL_VERSION` hand-copied into `bridge.js`, `bridge.js`'s own
  `PLUGIN_VERSION`, the MCP server's `SERVER_INFO.version`, and a hardcoded `extVersion` in
  `SocketServer.ts`'s `hello.ack`) — collapsed into ONE constant used for all of them (the wire
  protocol marker sent as `v`, the hello handshake's `pluginVersion`, the MCP `serverInfo.version`,
  and `hello.ack`'s `extVersion`); `Envelope.v` changed from `number` to `string` accordingly. TS
  side: `src/protocol/types.ts` does `import pluginManifest from "../../plugins/claude-code/
  .claude-plugin/plugin.json"` (needs `resolveJsonModule: true` in tsconfig — confirmed this works
  fine despite the file living outside `rootDir: "src"`; TS's JSON-module handling doesn't apply the
  rootDir check) and re-exports `pluginManifest.version` as `PLUGIN_VERSION`, so bumping the manifest
  updates every TS consumer automatically — no more hand-syncing a literal. Plugin side: `bridge.js`
  reads the SAME manifest at runtime via `require("../.claude-plugin/plugin.json").version` under its
  own `PLUGIN_VERSION` name (no separate `PROTOCOL_VERSION`); `mcp/server.js` reuses
  `bridge.PLUGIN_VERSION` for `SERVER_INFO.version`. Bump `plugin.json` whenever the wire shape
  changes incompatibly (checked via strict `===` in the hello handshake) — that's the one thing left
  to remember by hand, mirroring this file's existing convention for the plugin's plain-JS scripts.

- **Agent process-death is detected via an MCP liveness socket, not a PID.** Claude exposes no agent
  PID and `SessionEnd` doesn't fire on kill, so the MCP server holds a socket open; its drop →
  `removeSession` (ref-counted so layered connections don't drop the row early). A gate interrupt
  (Esc) drops a different connection → `markIdleOnDisconnect`.

- **The bridge targets ONLY the agent's own git-toplevel socket (`resolveTarget`), fail-open
  otherwise.** cwd-first: a worktree agent's toplevel is the worktree dir, a plain repo's is its root
  — never an ancestor. The old index-ancestor + ancestor-walk fallbacks leaked worktree events into an
  ancestor repo's window (wrong refreshes/rows/gates → blank Changes list) and were removed; no live
  socket for the exact toplevel → no target (hook scripts already fail open).

- **Hook scripts forward Claude Code's raw hook payload as-is; field-specific processing happens in
  the extension, not the plugin.** `on-event.js`/`on-plan-gate.js`/`on-review-gate.js` used to
  hand-pick fields into a bespoke camelCase shape (`sessionId`, `toolName`, `backgroundTaskCount`,
  …) — every time Claude Code added a hook field (e.g. `background_tasks`) the plugin scripts needed
  updating before the extension could see it. Now they just wrap the untouched JSON:
  `{ t, v, ts, harness: "claudecode", repoRoot, event: <raw Claude Code payload> }` (`repoRoot` is
  the bridge's own routing metadata, resolved from `cwd` via `resolveTarget` — not part of Claude's
  payload). `HookEventMessage`/`PlanReviewRequest`/`StopGateRequest` all carry `event:
  ClaudeCodeHookEvent` (defined in `ClaudeCodeStrategy.ts` — see the strategy-architecture entries),
  typed exactly as documented today (Claude Code
  hooks docs' common input fields + the per-event fields we consume — `ClaudeCodePermissionMode`/
  `ClaudeCodeEffortLevel` as literal unions, `ClaudeCodeBackgroundTaskSummary`/
  `ClaudeCodeSessionCronSummary` for the `background_tasks`/`session_crons` arrays) — **no catch-all
  index signature**; an undocumented field simply isn't accessible, on purpose. Every harness-specific
  type is `ClaudeCode`-prefixed (`ClaudeCodeHookEvent`, `ClaudeCodeHookEventName`,
  `ClaudeCodeNotificationType`, …) so it reads unambiguously at a call site — only `Harness`/
  `HookEventMessage`/`Envelope`/etc. (the harness-agnostic wire envelope, carrying a `harness: Harness`
  field to say which dialect it holds) stay unprefixed. `ReviewAwaitRequest`/`SessionAttachMessage`
  are NOT hook-script messages (they come from the MCP server/tool) and keep their existing flat shape.

- **All per-harness knowledge lives behind one `AgentStrategy` (`src/harness/`), resolved through an
  `AgentServiceLocator` registry; everything downstream consumes only the common `AppEvent`.** A
  strategy owns: raw-event→`AppEvent` mapping (`toAppEvent`, returns `undefined` to drop an
  irrelevant event), tool classification (`isEditTool`, `planProposal` kind — so the shared state
  machine never matches a harness tool name), display identity (`displayName`), the plan tool's
  user-facing wording (`planToolName`), the default plan-approve mode (`defaultPlanApproveMode`), and
  the debug-log rendering (`describeEvent`). `AppEventKind`/`AppNotificationKind` (camelCase) replace
  Claude's PascalCase `hook_event_name`/`notification_type`; `AppEvent` carries a `harness` stamp used
  only for the row label (via the locator) and the per-harness approve mode. The locator takes NO
  constructor args — it hard-codes the one strategy per harness internally (`{ claudecode, codex,
  opencode }`, the single place that knows the full set); `activate()` just does
  `new AgentServiceLocator()`. It's injected into the bridge handlers (transform at
  the boundary in `onHookEvent`/`onPlanReviewRequest`/`onStopGate` — `undefined` → drop/fail-open,
  logged at info), `PlanReviewController`, `MainTreeProvider`, and `SocketServer` (via `BridgeManager`)
  for `createInboundEventLog` (unknown wire harness → logs `msg.t` only). `strategyFor(harness)` is
  total over the closed `Harness` union (throws on a missing registration = wiring bug);
  `strategyForWire(name)` tolerates unvalidated wire strings. `AgentSessionService.ingest` is now
  `(event: AppEvent, repoRoot: string)` — it never sees a raw harness event. **Invariant: every wire
  event must be self-describing for its mapping** (`toAppEvent` is pure/sync/stateless); any
  cross-event correlation or async enrichment is plugin-side, before the wire.

- **`Harness` is now `claudecode | codex | opencode`; the wire `event` field is the
  `HarnessHookEvent` union (`ClaudeCodeHookEvent | CodexHookEvent | OpenCodeForwardedEvent`).**
  `AgentStrategy.toAppEvent`/`describeEvent` declare the union but each concrete strategy NARROWS its
  param to its own dialect — allowed only because TS checks method params bivariantly. This is NOT
  compile-time-sound: the runtime `harness` tag guarantees a strategy only ever gets its own dialect,
  and per-harness mapper fixture suites (built from empirically-pinned payloads via
  `src/test/harnessFixtures.ts`) are the safety net. `plan_markdown` (Codex/OpenCode) and
  `parentSessionID` (OpenCode) are documented as ADAPTER/PLUGIN-injected, not part of the harness's
  own payload. **Each dialect type is defined IN its strategy file** (`ClaudeCode*` in
  `ClaudeCodeStrategy.ts`, `Codex*` in `CodexStrategy.ts`, `OpenCode*` in `OpenCodeStrategy.ts`) —
  agent-specific types belong with their one consumer; `protocol/types.ts` keeps `PLUGIN_VERSION`/
  `Harness`/the envelope + message types and imports the dialects TYPE-ONLY for the `HarnessHookEvent`
  union (the resulting cycle is erased at compile time). Every harness-specific type stays
  `<Harness>`-prefixed so it reads unambiguously at a call site.

- **`AgentStrategy.supportsLiveness` (Claude/OpenCode true, Codex false) drives a silence-based
  sweep-removal fallback.** `AgentSessionService` takes the locator in its constructor and stamps
  `supportsLiveness` onto each `AgentSession` at construction. A harness with no process-death signal
  (no MCP liveness socket, no SessionEnd — Codex) can't be cleaned up on kill, so the existing sweep
  additionally REMOVES a `supportsLiveness:false` session once it's sat untouched in a non-active
  state past `LIVENESS_LESS_REMOVE_MS` (30 min). The 120s idle-downgrade runs first, so an active
  session becomes idle (non-active) before it can qualify. Liveness-capable harnesses are never
  removed this way.

- **Onboarding is per-agent: `OnboardingAgent.install(ctx)` + `installedProbe(ctx)`,
  `ctx = { pluginsRoot, stableDir }`** (`stableDir = <globalStorage>/adapters/<id>`, mkdirp'd before
  install). This replaced WelcomePanel's hardcoded claude-only check and the single globalState
  marker. Installed-ness is now a per-agent version stamp file in `stableDir`
  (`readInstalledStamp`/`writeInstalledStamp`); claude's install writes it after a successful CLI
  install. `installedProbe` returns a **tri-state** `InstallState` (protocol.ts) — `not-installed` /
  `update-available` (present but a stale version) / `installed` — so the card shows Set up / Update /
  ✓ Installed; Update just re-runs the idempotent installer. Version-stamp probes (claude/opencode)
  share `installStateFor(installed, shipped)`; Codex probes by install-path (`codexInstallState`:
  points at the current versionDir → installed, our marker but a stale path → update-available). An
  optional static `OnboardingAgent.note` renders under the card for opt-in setup steps (OpenCode's
  plan gate).

- **`RepoService.current()` anchors on the first workspace folder, using the active editor only for
  `file:`-scheme docs** (extracted pure `pickCurrentRepo`). A mid-review `refresh()` with a virtual
  `paireto-review:` doc active must not retarget a different discovered repo (getChanges then succeeds
  0/0/0 → blank view). Containment uses the `isInside` path.relative idiom (not startsWith), longest
  root wins; both sides canonicalized. `refresh()` logs loudly on a real root→root change.

- **"Agent finished" = entering a needs-you state** (stopped / awaiting permission / awaiting plan)
  **or a `Notification`** (Claude's "waiting for input" — covers question prompts that never reach a
  needs-you state), detected on the edge inside `AgentSession.fireNeedsYou`. Suppressed
  when this window is focused (no point nagging); cleared when a new turn starts. Drives
  `needsAttention`. Every fired ping is logged at info with a `notifyReason` (independent of
  `notify.type`, so unexpected pings are traceable even with sound off); focus-suppressed edges log
  at debug.

- **The needs-you sound is played by a `NotificationService` each `AgentSession` owns and calls
  directly** (`fireNeedsYou` → `notifications.notify(this)`), not via an event. Collapsed the old
  two-hop plumbing (`AgentSession` → host `onNeedsYou` → `AgentSessionService.onDidFinish` event →
  `NotificationController`) into one direct call — simpler and one layer fewer. `AgentSessionService`
  constructs one `NotificationService` (injectable for tests) and passes it to every session; the
  `onDidFinish`/`finishEmitter` and the host `onNeedsYou` callback are gone. Tests observe pings via a
  `RecordingNotifications` subclass injected into the service.

- **Agent visibility is per-session runtime mute (`AgentSession.muted`, `setMuted`).** A muted row
  stays listed (dimmed, `eye-closed` icon, `agentSession:muted` contextValue) so it can be re-enabled,
  but suppresses its needs-you ping (`fireNeedsYou` skips the mark/finish, logs the edge at debug) and
  drops out of `activityForRepo`'s state + needsAttention aggregates (status bar / switcher / published
  activity). Muting also clears any lingering `needsAttention`. Not persisted.

- **Subagent status is never tracked as UI state — `agentId`-carrying events bail out of `ingest`.**
  The one exception is `AgentSession.hasPendingWork`, which combines TWO signals so a `Stop` firing
  while there's real background work is **ignored outright** (logged at info, no state change), and
  is checked by `extension.ts`'s `onStopGate` handler BEFORE it ever calls into the review flow —
  `ReviewController.awaitStopOutcome`/`shouldOpenTurnEndReview` only ever reason about whether *this
  turn's* edits/comments warrant a review; they take no subagent/background-work signal at all, and
  never did need to once this check sits one layer up, where the raw Stop event is decided about
  using AgentSession's own owned state rather than pushed down into review-specific logic. Claude
  emits another Stop once everything finishes, and that one pings/reviews on the normal edge:
  1. A running-subagent SET (`activeSubagents`, id -> last-seen ms) fed by `SubagentStart`/
     `SubagentStop` (`trackSubagent`, before the bailout). This covers the classic **Task-tool**
     subagent, where those events (and tool calls tagged with its agentId) genuinely bracket its
     lifetime, but not perfectly reliably — a duplicate/erroneous `SubagentStop` can arrive while it's
     still emitting tool activity, so ANY other event carrying that agent's id revives its entry via
     `noteSubagentActivity`, and a 10-minute inactivity sweep (`SUBAGENT_STALE_MS`) is a backstop for
     one whose process died without ever reporting `SubagentStop`.
  2. **`background_tasks`/`session_crons` arrays carried directly on the `Stop`/`SubagentStop` hook's
     own raw payload** (`AgentSession.noteBackgroundWork` reads `.length` off them; Claude Code
     v2.1.145+, confirmed against the official CHANGELOG.md, absent → reads as zero on older CLIs).
     This is the signal for **background/async agents launched via the Agent tool, which emit NO
     `SubagentStart`/`Stop` or `agentId`-tagged events of their own at all** (confirmed empirically:
     only plain `PreToolUse`/`PostToolUse tool=Agent` on the parent) — the set above genuinely cannot
     see them, but Claude Code's own Stop payload directly reports "N background tasks still
     running", so no tracking/correlation is needed for this case at all. Because the blocking
     `stop.gate.request` (`on-review-gate.js`) is a SEPARATE socket connection from the passive
     `hook.event Stop` (`on-event.js`) — both fire off the same underlying Stop hook invocation but
     arrive independently — `extension.ts`'s `onStopGate` calls `AgentSessionService.noteBackgroundWork`
     with its own copy of the raw event before querying `turnState`, so both paths feed and read the
     one owned `AgentSession` state rather than duplicating the decision.

  The set/counts are never displayed; headline state still comes only from the top-level agent. All
  transitions log at info (gates the ping/review → must be traceable).

- **The stopped-edge ping fires only after a settle window (2s); other needs-you pings are
  instant.** A Stop is untrustworthy at event time: background-agent wake-turns end in a Stop then
  auto-resume, and subagent lifecycle events can be delivered out of order, so an instantaneous count
  check pings prematurely. Every event flows through ONE per-session gate call —
  `createDebouncedStop(...).consider(reason, shouldDebounce)` (`src/agents/debouncedStop.ts`):
  debounced (stopped) reasons wait out the window, undebounced ones fire on the next macrotask —
  every fire is ASYNC, and staleness is the callback's job: the single `fireNeedsYou` re-validates at
  fire time (still needs-attention, zero running subagents; skip logged at info). Tests await a tick.

- **Per-session state/behaviour live on the `AgentSession` class (`src/agents/AgentSession.ts`), the
  service only manages the list.** The class owns the hook-event state machine, subagent count, mute,
  attention marker, and the notification gate, talking back through an `AgentSessionHost` (focus
  lookup, emit callbacks, settle override); `AgentSessionService` routes events by session id, sweeps
  stale sessions, tracks liveness attachments, and aggregates per-repo activity. A consumer that needs
  more than one fact off a session's state (e.g. the Stop-gate review needs both `changedThisTurn`
  and `hasPendingWork`) gets it as ONE query — `AgentSessionService.turnState(sessionId)` returns
  a single `TurnState` object — rather than pulling each fact through its own getter and threading
  them as separate parameters across the bridge-handler/controller boundary.

- **Every inbound bridge message logs one debug line** (`bridge <- hook.event Stop agent=72a4f124
  tool=… type=…`, via `describeInbound` in SocketServer) — enough to reconstruct event order/timing
  when notification behaviour looks wrong, without dumping payloads.

- **The plugin must never register `WorktreeCreate`/`WorktreeRemove`.** `WorktreeCreate` is a
  DELEGATION hook — registering it replaces Claude Code's default creation and the hook must create
  the worktree and echo its path, so a passthrough observer breaks every worktree operation ("hook
  succeeded but returned no worktree path"); there is no observer mode. With no create signal the
  worktree cache can't stay coherent, so `WorktreeService` fetches fresh per switcher open instead
  (a test locks hooks.json against re-registration).

- **`Notification`s map onto the state machine instead of being a second ping channel**
  (`stateForNotification`): `permission_prompt` → `awaitingPermission`, `idle_prompt` → `stopped`,
  `elicitation_dialog`/`agent_needs_input`/missing type → the new `awaitingInput` state; informational
  types (`auth_success`, `agent_completed`, `elicitation_complete`/`response`) map to nothing. The
  ping is then ONE state-edge decision (`shouldNotify(state, prevState)`) — the notification that
  accompanies a permission prompt lands on the same state and can't double-ping. `notification_type`
  is a literal union (`NotificationType`, protocol/types.ts) forwarded by `on-event.js`.

- **Inline `view/item/context` buttons receive the tree NODE, not `item.command`'s arguments** — the
  eye toggle silently no-oped because its handler read `.sessionId` off the Node. Agent command
  handlers go through `commandSession()` (MainTreeProvider), which accepts both shapes.

- **The needs-you cue is visual + optional sound, never an OS push notification.** osascript banners
  are silently dropped and `alerter`/AXRaise needed extra installs + Accessibility — not worth it. So
  just a sound (`NotificationService`, `notify.type` = sound|disabled) plus an orange bell in the
  sidebar, status bar, and switcher.

- **Cross-window agent activity travels through per-repo files** (`$STATE/activity/<repoKey>.json`),
  since VS Code has no cross-window API. Each window publishes its own; the switcher reads them +
  `index.json` (`repoSnapshots`) to show other repos' state and whether a window is open.

- **The switcher's orange bell is a baked SVG, not a `ThemeIcon`+`ThemeColor`** — a QuickPick ignores
  the colour on an iconPath ThemeIcon (trees honour it, which is why the sidebar bell can stay one).

- **Switcher rows dedup by canonical path with section precedence (Current > Worktrees > Recents)** —
  a pure `buildSwitcherSections` (`src/status/switcherRows.ts`) keyed on precomputed `canonicalize()`
  paths kills the worktree-in-recents duplicate and /var vs /private/var skew in one Set. Labels are
  branch-first (branch ?? detached/basename) with the basename as description; recents' branches are
  fetched live at picker-open (`currentBranch`/`branchFromRevParse`) and folded in via a second
  `qp.items` assignment (persisting a branch on touch would go stale immediately).

- **Changed-file status indicators are coloured-letter SVGs (left iconPath), not FileDecorations** —
  a FileDecoration tints the whole label; the letter-only colour git uses is SCM-viewlet-only, not
  available to a TreeView. Tradeoff: left letter instead of a right-aligned one, no file-type icon.

- **Changed-files section rows carry a coloured left icon (`GROUP_ICON`) + the count description** —
  a TreeView has no right-aligned count badge like the SCM viewlet, so the layer (committed/staged/
  unstaged) is conveyed by a tinted `ThemeIcon`.

- **Auto-opened gates raise a non-blocking toast + focus the sidebar.** Plan
  (`notifyPlanOpened`) / turn-end review (`notifyReviewOpened`, NOT `/paireto-review`) show a
  `showInformationMessage` with quick actions (View Plan/Start Reviewing, Approve Immediately);
  handlers re-check the gate is still pending.

- **Plan tab name is human (`planDocLabel`), URI uniqueness rides in the query.** The
  `paireto-plan://` URI's path is `PLAN: <first line> - <datetime>` (the visible tab) and the unique
  `planId` goes in `?query` — keeps the content-provider map (keyed by `uri.toString()`) collision-
  free without polluting the tab name.

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
  NUL-byte check) so it doesn't defeat the image diff. A diff tab showing this file as its modified
  side satisfies `vscode.open`'s "already open" check without ever showing the plain file — `openFile`
  closes any such diff tab first (`closeTabsWhere`, any tab group, not just the active one), then
  calls plain `vscode.open`, which switches to an already-open plain tab as normal.

- **`openDiff`'s `activeDiffEmitter` only fires for genuine user-driven diff focus, not a silent
  reopen.** It's what drives "tree selection follows the diff in focus" (`MainTreeProvider.reveal`),
  but `reconcileOpenDiffsAfterWrite` also calls `openDiff` to silently re-point an already-open tab
  after stage/unstage/discard moves it a git layer — firing the emitter there scrolled/selected the
  tree on every stage/unstage with no user-visible focus change. That one call site passes
  `suppressActiveDiffEvent: true`; `maybeMarkAsUnstaged`'s intentional unstaged-highlight emit and
  normal user-driven `openDiff` calls (tree click, `reviewOpenDiff` command) are untouched.

- **The tree-follows-active-editor sync honours `explorer.autoReveal`** (`resolveAutoReveal` in
  `src/util/editorSettings.ts` — self-contained readers for the built-in editor settings we honour
  live here): focusing a review diff tab pulled the Paireto sidebar forward + moved the tree
  selection unconditionally; now `syncSelectionToActiveTab` bails when
  `explorer.autoReveal` is `false`, matching native explorer semantics (`true`/`"focusNoScroll"` →
  still reveal; we can't suppress the scroll via the TreeView API so `"focusNoScroll"` behaves like
  `true`). Only the focus-follow path is gated — tree-click and edit-location reveals are unaffected.

- **Adds/deletes open a SINGLE editor, not a two-pane diff** (`singlePaneSide`): one side is empty, so
  a diff would render a broken/empty pane (an image viewer can't show the 0-byte side). Add → show the
  modified side; delete → show the base. Both panes still match the comment controller (file: side or
  paireto-review side), so they stay commentable.

- **Every open diff owns a pinned baseline, independent of its current Git layer.** Editing a
  staged/committed diff changes only the tracked tree location to Working Tree; it never rewrites the
  base URI to the index. Stage/unstage reconciliation also carries the same baseline forward. The
  editor-title **Compare To** action is the only way to change a tab's baseline and offers Index,
  HEAD, merge-base, default branch, recent refs, and arbitrary refs. The title names the active base.
  Both Compare-To pickers use `createQuickPick` and set `activeItems` to the persisted/tab-local
  value (`QuickPickItem.picked` is ignored for single-select); unknown current refs get an explicit
  current-comparison row, and the nested branch/ref picker highlights the current ref too.

- **Review comments own durable attachment metadata** (`group`, pinned `baseRef`/label, source URI)
  in addition to their quote/context anchor. Sidebar reveal must use `selectCommentFile` so the saved
  group wins for partially staged paths, then migrate across layer changes/renames. It re-scores the
  saved quote and before/after context with `relocateReviewAnchor`, and `CommentSession.reattach`
  creates the replacement thread before disposing the old one. Never delete a comment because its
  original document or exact line is unavailable; fall back to current working content, the prior
  URI, or a historical base document. Once `openDiff` has opened a review surface, reveal must not
  call `vscode.open` on the side URI—it creates an unwanted duplicate plain-file tab; standalone
  opening is reserved for the no-review-surface fallback.

- **Diffs sync with git via one funnel: `refresh()` → `ReviewContentProvider.refreshAllOpen()`.** Do
  NOT add a custom `**/*` FileSystemWatcher (an earlier one pinned the CPU on autosave churn) — the
  VS Code git extension's `onDidChange` is the sole background sync trigger. `openDiff()` additionally
  awaits `refresh("open-diff")` and invalidates its exact base/modified URIs before opening, because
  `refreshAllOpen()` cannot clear provider cache entries left by a previously closed tab. Provider
  cache entries are generation-guarded so a pre-refresh async read cannot finish late and overwrite
  fresh content. `log.info` records decisions.

- **Folder rows reuse the file stage/unstage/discard commands** — a folder's `contextValue` is
  `folder:<group>` and handlers flatten it to descendant files. Committed rows are read-only.

- **Agent rows are labelled `Claude (<short id>)`** (harness name + `sessionId.slice(0,8)`), not the
  repo basename — the basename was identical for every agent in a repo; repo/start-time/tool live in
  the tooltip.

- **Comment author = signed-in account → OS user → "Developer"** (`comments/author.ts`, cached; the VS
  Code `authentication.getSession` lookup is async+silent so it's resolved once at activation).

- **Approving a plan defaults the agent into `auto` mode** via the PermissionRequest decision's
  `updatedPermissions: [{type:"setMode", mode}]` (Claude otherwise restores the pre-plan mode).
  Overridable by per-harness config keys `paireto.planApprove.mode.<harness>` (claudecode: enum,
  default `auto`; opencode: agent name, default `build`; NO codex key — no settable mode). The key's
  value wins over the strategy's `defaultPlanApproveMode` via `resolvePlanApproveMode`; `off` (or a
  harness with no key/default) leaves the mode unchanged.

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

- **Socket binding is workspace-folder-driven, keyed by a git-CLI-resolved toplevel, never
  `vscode.git`'s reported root.** A worktree window and its main repo's window were cross-talking
  because `extension.ts` bound sockets off `RepoService.repositories` (a raw passthrough of
  `vscode.git`'s own `Repository.rootUri`) while the plugin/hook side independently resolves its own
  toplevel via real `git -C <cwd> rev-parse --show-toplevel` (`bridge.js`) — the two were assumed, but
  never checked, to agree. `gitCli.ts` now exports `gitToplevel(cwd)` mirroring `bridge.js` exactly;
  `extension.ts` binds one socket per `vscode.workspace.workspaceFolders` entry resolved through it
  (tracked in a `Map<folderFsPath, toplevel>`, added/removed via
  `onDidChangeWorkspaceFolders`), never off `vscode.git`'s reporting.
  `BridgeManager.ensureServerFor` now logs resolved roots, successful binds, and — previously
  silent — binds skipped because another window owns the socket. `IndexRegistry.gc()` skips
  unlinking `.sock`/activity files younger than a 10s grace period (a concurrently-starting window's
  fresh bind could otherwise be deleted before it's indexed) and logs removals.
  `BridgeManager.isOwnedByLiveServer` now checks PID liveness (`IndexRegistry.isEntryLive`) instead
  of trusting raw index presence.

- **Codex adapter = a self-contained `plugins/codex/` bundle (`adapter.json` + hand-mirrored
  `bridge.js` + hook scripts), version-locked to `PLUGIN_VERSION`** (a test asserts every
  `plugins/*` manifest matches). `bridge.js` reads its version from `../adapter.json`; scripts stamp
  `harness:"codex"`. Adding the harness on the extension side was just `new CodexStrategy()` in the
  locator — the AgentStrategy seam carries everything else.

- **Codex has no plan/review hooks of its own, so ONE Stop-hook script (`on-stop-gate.js`) forks on
  `permission_mode`.** `stop_hook_active` → allow (our block's follow-up); `permission_mode==="plan"`
  → plan gate (deny = `{"decision":"block","reason"}`, allow = emit nothing so the stop proceeds and
  Codex stays in plan mode — it has no settable approve mode); else the turn-end review gate, exactly
  like Claude's `on-review-gate.js`. Plan text is COMPOSED plugin-side (self-contained gate event):
  the Stop payload's `last_assistant_message` prose is primary, with the `update_plan` checklist
  appended under a `## Plan` heading when present (`on-plan-stash.js`, PostToolUse `update_plan`,
  renders the step array to `$XDG_STATE/paireto/codex-plans/<session_id>.json`); stash-only when the
  message is empty. The composed string is injected as `plan_markdown`.
  `CodexStrategy` maps `Stop`+`permission_mode==="plan"` → `planProposal` (planText = `plan_markdown`);
  `isEditTool = {"apply_patch"}`; `supportsLiveness:false` (no MCP session id → silence sweep only).

- **The Codex installer auto-trusts by writing the `trusted_hash` itself** — Codex silently skips
  untrusted hooks and has no non-interactive trust CLI, but the hash is deterministic
  (`{event_name,[matcher],hooks:[{type,command,timeout(def 600),async:false}]}`, keys sorted, compact
  JSON, `sha256:` prefix — reproduced + verified against real config.toml vectors). If a Codex
  release changes the algorithm, hooks skip = Paireto fail-open, not breakage. Install = copy
  `plugins/codex/` → `<stableDir>/<version>/` (durable, absolute script paths), jsonc-merge our
  groups into `~/.codex/hooks.json` (dedupe ours by the stableDir marker, APPEND at the tail so
  foreign group indices — which key their positional trusted_hash — never shift), then
  existence-checked EOF-append the `[hooks.state."…"]` subtables to `~/.codex/config.toml` (never
  rewrite foreign content; no TOML parser). Every file-shape step is a pure, unit-tested function.

- **The Codex installer also ensures `[features] hooks = true` in config.toml** — Codex's master
  switch; with it absent/false NO hook runs (trust hashes are moot). Same string-level, existence-
  checked policy (`ensureCodexFeaturesHooks`, pure + tested): no `[features]` table → append at EOF;
  table present with `hooks` set → leave the user's choice ALONE (never flip a deliberate `false`,
  just surface `hooksDisabled` so the install result / Welcome copy warns); table present without a
  `hooks` key → insert `hooks = true` after the header.

- **Codex process-death is caught by a stdio-MCP liveness server (`plugins/codex/mcp/liveness.js`),
  correlated by PPID handoff.** Codex spawns `[mcp_servers.paireto]` at startup and strips its env, so
  it has no session id: the SessionStart/UserPromptSubmit hooks write `handoff/codex-<codexPid>.json`
  (codexPid = nearest `codex` ancestor, shared `bridge.codexPid`/`handoffPath`), the server polls it
  and holds a `session.attach` socket open per session (re-attaching on `/new`). It exits — closing
  the socket → the generic `detachSession` clears the row — on BOTH stdin EOF (SIGKILL orphans it but
  closes stdin ~34 ms) and SIGTERM (graceful codex exit). Installer merges the table into config.toml
  (`upsertCodexMcpServer`, existence-checked/foreign-preserving), injecting `env.XDG_STATE_HOME` ONLY
  when the extension has it set (Codex strips it; the default `~/.local/state` matches otherwise).
  `CodexStrategy.supportsLiveness` stays FALSE so the silence sweep remains the backstop for a
  never-attached session (no window, state-dir divergence). No extension changes — attach/detach is
  harness-agnostic.

- **OpenCode adapter = one self-contained ES-module plugin (`plugins/opencode/paireto.js` +
  `adapter.json` + `commands/paireto-review.md`).** Gates on a real git worktree (OpenCode reports
  `worktree "/"` in a non-git dir → the factory returns `{}`); resolves the per-repo socket from the
  canonicalized worktree byte-identically to `protocol/paths.ts`. The `event` hook forwards
  session/permission/file/user-message events fire-and-forget over ONE lazily-reconnected connection
  (writes serialized), stamping each with the owning `sessionID` and — the one plugin-side
  correlation — a `parentSessionID` for known child sessions. `tool.execute.before/after` are awaited
  hooks re-emitted as synthetic events that RETURN IMMEDIATELY. Liveness: a held-open `session.attach`
  connection per top-level session, closed on `session.deleted`/`server.instance.disposed`
  (`supportsLiveness:true`). Two custom tools BLOCK the agent via `execute():Promise<string>` —
  `paireto_review` (turn-end review analog of the Claude MCP tool) and `paireto_submit_plan` (the plan
  gate — the automation layer below steers the agent onto it, no user instruction needed). Fail-open
  throughout.

- **`OpenCodeStrategy` models a sub-agent as a full child SESSION.** `session.created` with no
  `info.parentID` → `sessionStart`; with one → `subagentStart {sessionId: parentID, agentId: childId}`.
  Any event the plugin tagged with `parentSessionID` routes to the parent row carrying the child id as
  `agentId` (so the `AgentSessionService` agentId-bailout keeps it off a top-level row); a child's
  `session.idle`/`deleted` → `subagentStop`. Top-level `session.idle` → `stop`, `session.deleted` →
  `sessionEnd`. `tool.execute.before(paireto_submit_plan)` and `paireto.plan.submitted` →
  `planProposal` (planText from the gate event's `plan_markdown`). Top-level `session.idle` also maps
  to `stop` for the POST-HOC turn-end gate below. On plan approval `nextMode` = the target AGENT to
  switch to (not a permission mode); `defaultPlanApproveMode = "build"`.

- **OpenCode automation = plugin instructs the agent itself (zero user setup); pure decision helpers
  unit-tested via the `_internals` export (`openCodeAutomation.test.ts` dynamic-imports the shipped
  JS).** `paireto.js` must expose ONLY loader-safe exports: OpenCode invokes EVERY export as a plugin
  factory `fn(input, options)` and hard-errors on non-function exports ("Plugin export is not a
  function") — directly-exported helpers crashed opencode's boot (read their params off the wrong
  objects). Helpers therefore ride `_internals`, an inert callable plugin (`async () => ({})`) with
  the helpers attached as properties; an export-shape test locks this. Why the automation:
  OpenCode has no ExitPlanMode gate to intercept on 1.15.10, so — mirroring the vendored
  plannotator plugin — a `config` hook scopes `paireto_submit_plan` to planning agents (`primary_tools`
  + per-agent allow/deny; in-place permission mutation, never a spread, to dodge the string-vs-object
  hazard), and `experimental.chat.system.transform` appends a lean planning prompt for a resolved
  planning-agent session (agent = last user message's `agent`, cached `app.agents`; title-generator
  prompt skipped). `tool.definition` rewrites a future `plan_exit` tool toward `paireto_submit_plan`
  (no-op today). Approve → `submit_plan.execute()` switches to `nextMode` via
  `client.session.prompt({agent, noReply:true})`. The `paireto_submit_plan` `args` MUST be a real
  zod schema (`{ plan: schema.string() }`) — OpenCode types `args` as ZodRawShape and a bare value
  (`""`) throws during schema advertisement/validation, so the plan never reaches VS Code. The zod
  comes from the SDK's `tool.schema`, dynamic-imported inside the factory (`@opencode-ai/plugin`,
  provided by OpenCode's runtime) so top-level imports stay node-builtins-only and the unit tests
  still load the pure helpers; `planToolArgs()` fails open to `{}` when the SDK is absent.

- **OpenCode turn-end review is POST-HOC (session.idle can't park an idle agent).** On each TOP-LEVEL
  `session.idle` the plugin fires a blocking `stop.gate.request` (child idles = subagents finishing,
  skipped via the `parentOf` map); the extension's `onStopGate` is untouched. `allow` → nothing;
  `block`+reason → inject the feedback as a fresh user turn (`session.prompt`) to resume the agent.
  STRICT fail-open: no window / timeout / drop / blank reason inject NOTHING — feedback reaches the
  agent only on an explicit Send Feedback. Loop safety mirrors Claude (userPromptSubmit resets
  changedThisTurn; review slot serializes).

- **The OpenCode installer is a plain three-file copy into `~/.config/opencode/`** (`plugin/paireto.js`
  + `plugin/adapter.json`, `commands/paireto-review.md`) — OpenCode autoloads both dirs, no CLI/config
  edit. merge-don't-clobber comes for free: only our own filenames are written, foreign files in those
  shared dirs untouched (no broad dir copy). Probe = the installed `plugin/adapter.json` version
  matches the shipped one. The copy plan + version parsing are pure, unit-tested; no stableDir staging
  (OpenCode loads the file in place).

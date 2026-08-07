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

- **A window owns a canonical root catalog, not an active-editor repository.** Raw VS Code workspace
  folders are agent-addressable roots (including non-Git folders); CLI `git rev-parse --show-toplevel`
  is authoritative for each folder's owning repo/worktree; vscode.git contributes verified nested
  repos and submodules. An ancestor vscode.git root that disagrees with the CLI root is rejected to
  preserve worktree identity. The bridge reconciles one socket per catalog root and tears down its
  live connections when a root disappears. First-window-wins still applies per socket.

- **Changes state is repository-qualified and window-wide.** Review models, open-diff keys, Git
  actions, comments, and selection events all carry `repoRoot`. Multiple repos add a repository
  folder layer in the tree; a single repo keeps the old compact layout. Compare To is shared: multi-
  repo mode exposes only semantic presets (HEAD / merge-base / default branch), resolved separately
  by each repo, while single-repo mode retains arbitrary/recent refs.

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
  `src/test/harnessFixtures.ts`) are the safety net. Adapter-injected enrichment (a Codex plan
  recovered from a transcript, an OpenCode child→parent correlation) is NEVER merged into `event` —
  `event` is BY DEFINITION the harness's own untouched payload — it rides ALONGSIDE in the envelope's
  optional `meta: HarnessEventMeta` (`{ planMarkdown?, parentSessionId? }`), passed to `toAppEvent` as
  a second arg. The one exception isn't an exception: OpenCode's fully SYNTHETIC events (`paireto.
  plan.submitted`, `tool.execute.*`) are the plugin's OWN dialect, so a field like `plan_markdown` on
  the synthetic plan event touches no raw harness payload. **Each dialect type is defined IN its strategy file** (`ClaudeCode*` in
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
  share `installStateFor(installed, shipped)`; Codex probes its public native plugin registry with
  `codex plugin list --json`. An
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

- **`activationEvents` includes `onFileSystem:paireto-review`** — `onStartupFinished` fires AFTER
  the workbench restores editors, so a restored review diff tab resolved with no provider registered
  and showed an error until "Try Again". `onFileSystem:<scheme>` makes VS Code fire activation and
  wait for the provider registration before completing the read (a manifest test locks the event).

- **Review URIs put the workspace-relative file path in the URI path; side + relPath + ref + repo
  all ride in the query** — VS Code renders breadcrumbs/tab paths from URI path segments, so the old
  `/<side>/<relPath>` shape showed "modified / src / …". Display path mirrors `asRelativePath`
  (folder name prefixed only in multi-root, CLOSEST containing folder wins, both sides canonicalized
  so a symlinked folder path still matches the git-canonical repoRoot; falls back to repo-relative
  outside the workspace); `side` in the query keeps a diff's two URIs distinct. One class owns both
  directions: `ReviewPath` (`src/review/ReviewPath.ts`) — `fromFile`/`fromUri` in, `toUri`/
  `displayPath` out; nothing else builds or parses the shape. No backward compatibility with the
  pre-breadcrumb shape (user decision): a diff tab restored across that upgrade renders empty and is
  simply reopened.

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
  VS Code git extension's `onDidChange` is the sole background sync trigger. `openDiff()` does NOT
  run that full refresh (getChanges + currentBranch per root + refreshAllOpen re-running git show per
  open URI made opening laggy in large projects): it awaits a scoped per-file sync instead
  (`syncFileForOpenDiff` → `DiffService.changesForPath`; tracked diffs run WHOLE and are filtered to
  the path afterwards — a pathspec holding one side of a rename pair makes git report a phantom D/A
  instead of the R — pathspec only on the untracked `ls-files` walk, with the `:(literal)` magic
  prefix so a leading-':' / glob-charactered filename still matches itself; the scoped path set is widened
  across rename pairs to a fixpoint (`widenAcrossRenames`) so it covers everything the merge drops as
  affected — a rename's other half can carry its own changes, which would otherwise vanish from the
  model with no replacement; one shared
  `DiffService.scan` behind both so a path's group can't diverge between the tree and the sync) that
  merges the one path's current groups into the in-memory model — so a layer move/disappearance since
  the tree rendered is still handled — falling back to a full refresh only when the repo has no model
  yet. The sync participates in the refreshSeq protocol by OBSERVING, never claiming (claiming would
  discard a complete in-flight refresh's model): it merges into the LIVE model — so a refresh() that
  landed mid-sync is never reverted — and a refresh() that STARTS mid-sync supersedes it (defer to a
  full refresh, reason `open-diff-superseded`; a scoped write could fight the newer data, and bailing
  would leave openDiff a stale model that makes the open fall through). A refresh already in flight
  when the sync began passes the seq check, so a live-vs-snapshot `compareRef` mismatch also defers
  to the full refresh — the scoped result was computed against the old ref and merging it would
  inject/drop committed entries in the new model. It
  still invalidates its exact base/modified URIs before opening, because `refreshAllOpen()` cannot
  clear provider cache entries left by a previously closed tab. Provider cache entries are
  generation-guarded so a pre-refresh async read cannot finish late and overwrite fresh content.
  `log.info` records decisions.

- **Folder rows reuse the file stage/unstage/discard commands** — a folder's `contextValue` is
  `folder:<group>` and handlers flatten it to descendant files. Committed rows are read-only.

- **Agent rows are labelled `Claude (<short id>)`** (harness name + `sessionId.slice(0,8)`), not the
  repo basename — the basename was identical for every agent in a repo; repo/start-time/tool live in
  the tooltip.

- **A comment's repo-relative path canonicalizes BOTH sides (`repoRelativePath`).** A repo root comes
  from git and is symlink-free; a `file:` URI keeps whatever path the workspace was opened with. On
  macOS a repo under `/tmp` (a symlink to `/private/tmp`) made the raw subtraction escape the repo,
  so review feedback told the agent to fix `../../../tmp/<repo>/hello.txt` instead of `hello.txt` —
  and `isChangedFileDoc` failed to recognise its own changed files. This reaches any user whose repo
  path contains a symlink, not just the E2E sandbox. Found by the strict-replay diff: the Docker
  recording said `hello.txt:1` where a native run sent the escaped path.

- **Comment author = signed-in account → OS user → "Developer"** (`comments/author.ts`, cached; the VS
  Code `authentication.getSession` lookup is async+silent so it's resolved once at activation).

- **Approving a plan defaults the agent into `auto` mode** via the PermissionRequest decision's
  `updatedPermissions: [{type:"setMode", mode}]` (Claude otherwise restores the pre-plan mode).
  Overridable by per-harness config keys `paireto.planApprove.mode.<harness>` (claudecode: enum,
  default `auto`; opencode: agent name, default `build`; NO codex key — no settable mode). The key's
  value wins over the strategy's `defaultPlanApproveMode` via `resolvePlanApproveMode`; `off` (or a
  harness with no key/default) leaves the mode unchanged.
  - **Claude Code emitAllow shape (empirical, CLI 2.1.207 / July 2026):** since ~2.1.199
    (anthropics/claude-code#74256) the CLI DISCARDS an ExitPlanMode allow unless the decision carries
    `updatedInput` — a bare `{behavior:"allow"}`, or one carrying only `updatedPermissions`, falls
    back to the native "Would you like to proceed?" prompt. WITH the tool's own input echoed back
    unchanged as `updatedInput` (`{plan, planFilePath}`, a schema-valid no-op), the allow is honored
    AND the `updatedPermissions:[{setMode}]` riding alongside is applied — the fields COMPOSE (same
    fix as plannotator#1008 / caret#192). `on-plan-gate.js` therefore always echoes `updatedInput`
    and keeps the `nextMode`→setMode switch. deny was never affected.
  - **ExitPlanMode's `plan` argument is OPTIONAL and routinely absent — recover it from the plan FILE
    (`plugins/claude-code/scripts/plan-file.js`).** Empirically confirmed in recorded live API
    traffic: the model streams `ExitPlanMode` with `input:{}` (one empty `input_json_delta`), and the
    CLI itself back-fills `{plan, planFilePath}` from the file it wrote for the NEXT request. Our
    PermissionRequest hook fires at call time, before that back-fill, so without recovery the plan
    review opens EMPTY. This is intended CLI design (the plan lives in a file), not a bug awaiting an
    upstream fix. `resolvePlanMarkdown` prefers `tool_input.planFilePath`, else the newest `.md` in
    `CLAUDE_CONFIG_DIR ?? ~/.claude` + `/plans` written within `PLAN_FILE_MAX_AGE_MS` (60s) — the
    freshness window is load-bearing: that directory is shared by EVERY session and repo, so
    newest-wins alone could hand this gate another agent's plan. Recovery rides in
    `meta.planMarkdown` ALONGSIDE the untouched event (never merged into `tool_input`), exactly like
    Codex's transcript recovery; `ClaudeCodeStrategy` reads `tool_input.plan ?? meta.planMarkdown`.

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
  so commenting works in both cases. Every comment also carries its repository root; feedback uses
  absolute file paths when the window contains multiple Git repos so same-named relative paths are
  unambiguous to the agent.

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

- **Codex adapter = a native, self-contained plugin sourced from `plugins/codex/`**
  (`.codex-plugin/plugin.json`,
  `hooks/hooks.json`, `.mcp.json`, `skills/`, scripts), version-locked to `PLUGIN_VERSION` (a test
  asserts every `plugins/*` manifest matches). `bridge.js` reads its version from the native plugin
  manifest; scripts stamp `harness:"codex"`. Adding the harness on the extension side was just
  `new CodexStrategy()` in the locator — the AgentStrategy seam carries everything else.

- **Codex has no dedicated plan-review event, so ONE Stop-hook script (`on-stop-gate.js`) serves
  plan and turn-end review gates.** The supported Stop contract is deliberately narrow: it receives
  `permission_mode` as input; `decision:"block"` creates a new continuation prompt from `reason`;
  exiting successfully with no output lets the turn finish. Stop has no output for changing
  collaboration mode. `PermissionRequest` can allow or deny a tool escalation, but cannot approve
  native Plan mode. Therefore Send Feedback blocks Stop and Codex revises the plan, while Approve
  allows Stop and Codex presents its own "Implement this plan?" approve-and-switch selector. The user
  must select it; only the E2E driver presses Enter as the simulated user. Unlike Claude Code, Paireto
  cannot fully move Codex from planning into implementation through a hook response. Contract source:
  https://developers.openai.com/codex/hooks/.
  `stop_hook_active` is deliberately NOT short-circuited: the follow-up Stop after feedback carries
  the revised plan / addressed edits and must re-gate (loop safety = the extension only blocks on an
  explicit decision). Plan markdown comes from the ROLLOUT TRANSCRIPT (`bridge.readPlanTurn`, matched
  on the Stop's `turn_id`): `permission_mode` can identify Plan mode but does not contain the plan,
  and `last_assistant_message` is null there. `event_msg`/`item_completed` with `item.type=="Plan"`
  carries the markdown; `turn_context.collaboration_mode.mode=="plan"` corroborates it. Strict replay
  may serialize the same native plan as a `<proposed_plan>` response/task-complete item. The recovered
  text rides in `meta.planMarkdown` alongside the untouched raw Stop event. `CodexStrategy` maps
  `Stop` + `meta.planMarkdown` present → `planProposal`; `isEditTool = {"apply_patch"}`;
  `supportsLiveness:false` (no MCP session id → silence sweep only).

- **The Codex installer uses only the public native plugin CLI for the live integration.** It copies
  the bundle into `<stableDir>/marketplace/plugins/paireto`, writes the marketplace contract at
  `<stableDir>/marketplace/.agents/plugins/marketplace.json`, then runs
  `codex plugin marketplace add` + `codex plugin add paireto@paireto`. The stable marketplace path
  survives VSIX upgrades while Codex owns caching, component namespacing, enablement, and its normal
  one-time hook trust review. The installer does not read or mutate Codex's global hook, MCP, or
  skill configuration; the self-contained plugin bundles only its reusable review skill.

- **Codex process-death is caught by a plugin-scoped stdio-MCP liveness server
  (`plugins/codex/mcp/liveness.js`), correlated by PPID handoff.** Codex spawns the bundled `.mcp.json`
  server at startup and strips its env, so
  it has no session id: the SessionStart/UserPromptSubmit hooks write `handoff/codex-<codexPid>.json`
  (codexPid = nearest `codex` ancestor, shared `bridge.codexPid`/`handoffPath`), the server polls it
  and holds a `session.attach` socket open per session (re-attaching on `/new`). It exits — closing
  the socket → the generic `detachSession` clears the row — on BOTH stdin EOF (SIGKILL orphans it but
  closes stdin ~34 ms) and SIGTERM (graceful codex exit). The handoff always uses a HOME-based
  rendezvous and records the exact socket path computed by the hook, so the MCP child never needs
  the filtered XDG_STATE_HOME.
  `CodexStrategy.supportsLiveness` stays FALSE so the silence sweep remains the backstop for a
  never-attached session (no window, state-dir divergence). No extension changes — attach/detach is
  harness-agnostic.

- **OpenCode adapter = one self-contained ES-module plugin (`plugins/opencode/paireto.js` +
  `adapter.json` + `commands/paireto-review.md`).** Gates on a real git worktree (OpenCode reports
  `worktree "/"` in a non-git dir → the factory returns `{}`); resolves the per-repo socket from the
  canonicalized worktree byte-identically to `protocol/paths.ts`. The `event` hook forwards
  session/permission/file/user-message events fire-and-forget over ONE lazily-reconnected connection
  (writes serialized), stamping each with the owning `sessionID`; a known child session's — the one
  plugin-side correlation — parent rides in the envelope's `meta.parentSessionId` (ALONGSIDE the raw
  event, never a field on it). `tool.execute.before/after` are awaited
  hooks re-emitted as synthetic events that RETURN IMMEDIATELY. Liveness: a held-open `session.attach`
  connection per top-level session, closed on `session.deleted`/`server.instance.disposed`
  (`supportsLiveness:true`). Two custom tools BLOCK the agent via `execute():Promise<string>` —
  `paireto_review` (turn-end review analog of the Claude MCP tool) and `paireto_submit_plan` (the plan
  gate — the automation layer below steers the agent onto it, no user instruction needed). Fail-open
  throughout.

- **`OpenCodeStrategy` models a sub-agent as a full child SESSION.** `session.created` with no
  `info.parentID` → `sessionStart`; with one → `subagentStart {sessionId: parentID, agentId: childId}`.
  Any event carrying a `meta.parentSessionId` routes to the parent row carrying the child id as
  `agentId` (so the `AgentSessionService` agentId-bailout keeps it off a top-level row); a child's
  `session.idle`/`deleted` → `subagentStop`. Top-level `session.idle` → `stop`, `session.deleted` →
  `sessionEnd`. `tool.execute.before(paireto_submit_plan)` and `paireto.plan.submitted` →
  `planProposal` (planText from the synthetic gate event's `plan_markdown` — that event is the
  plugin's OWN dialect, so the field is legitimate there). Top-level `session.idle` also maps
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
  changedThisTurn; review slot serializes). `changedThisTurn` is set ONLY by the native edit-tool
  `postToolUse` edge (write/edit/apply_patch); a model that edits via `bash` bypasses detection
  (ACCEPTED — mitigate by model choice; an EXTENSION-side diff could close it someday). One subtlety
  kept for turn-end correctness: a user `message.updated` forwards as userPromptSubmit only ONCE per
  message id (OpenCode re-fires it at turn-end, which would otherwise reset changedThisTurn AFTER the
  edits).

- **Plugins and hooks are stateless: they do not process data that can be calculated on the
  extension side.** They forward events as-is and enrich them with additional metadata (envelope
  `meta`, repoRoot, plan text recovered from a transcript) so the EXTENSION can do the stateful
  calculations instead. Anything resembling change detection, diffing, or cross-turn state belongs
  extension-side.

- **The OpenCode installer is a plain three-file copy into `~/.config/opencode/`** (`plugin/paireto.js`
  + `plugin/adapter.json`, `commands/paireto-review.md`) — OpenCode autoloads both dirs, no CLI/config
  edit. merge-don't-clobber comes for free: only our own filenames are written, foreign files in those
  shared dirs untouched (no broad dir copy). Probe = the installed `plugin/adapter.json` version
  matches the shipped one. The copy plan + version parsing are pure, unit-tested; no stableDir staging
  (OpenCode loads the file in place).

- **The E2E suite is socket-anchored: the per-repo unix socket is both the await point (blocking
  gate requests) and the drive point (real `paireto.gate.*` commands).**
  The full-flow test (`src/e2e/tests/fullflow.e2e.ts`) runs inside the extension host
  (`@vscode/test-electron`, `src/e2e/runE2E.ts`); real TUIs run in an EXTERNAL tmux session where a
  harness requires one. Drivers perform setup and only user actions their harness cannot express via
  hooks. Claude approval continues from its hook-provided mode switch; an OpenCode plan-tool miss
  fails the original run instead of silently retrying; Codex waits for the native "Implement this
  plan?" selector and presses Enter as the simulated user. Absence of that selector fails the test.
  All plan/review state assertions remain socket-based; Codex pane capture is limited to confirming
  and operating this real native transition.
  `XDG_STATE_HOME` must be a SHORT /tmp path — macOS's ~104-char `sun_path` limit EINVALs long socket
  paths. Drivers: claudecode/codex/opencode — each costs cents/run; a selected driver whose binary/auth
  is missing is a hard FAIL with the reason (never a silent skip — you asked for that driver).
  `PAIRETO_E2E_DRIVER` has NO default (unset → runE2E exits asking for one). The
  Codex and OpenCode drivers pin `gpt-5.6-luna` (OpenCode names it `openai/gpt-5.6-luna`) to keep
  live runs cheap. Codex's root TOML settings must be written before installer-owned tables;
  appending them after `[plugins]` silently scopes them to that table, falls back to the account's
  default model, and enables WebSocket GET attempts that record as 405s. Its custom provider sets
  `supports_websockets = false`, leaving only replayable Responses-over-SSE POSTs.
  See src/e2e/README.md.

- **Mock E2E proxy keys are long-lived machine-local resources, not repository assets or install artifacts.**
  The first record/check invocation generates a ten-year CA and leaf identity under the ignored,
  mode-0700 `src/e2e/proxy/certs/` directory; later invocations validate and reuse it. A missing,
  mismatched, corrupt, SAN-incomplete, or near-expiry identity is replaced automatically. Only the
  mode-0600 leaf key remains after generation — the CA signing key and build intermediates are deleted.
  Generation stays tied to E2E use rather than `postinstall`, and the only committed trust material is
  MockServer's fixed public CA certificate.

- **Codex E2E scopes every config override; only the model pin is unconditional
  (`renderCodexRuntimeConfig(existing, project, {mock, docker})`).** A LIVE NATIVE run must still look
  like a real Codex user, so it keeps Codex's own provider, default transport, approval policy and
  sandbox — that run is the only coverage those paths get. Scoped off it: the custom
  `paireto_openai` provider + `supports_websockets = false` + `enable_request_compression = false`
  (mock only — they exist purely to make traffic replayable), and `approval_policy = "never"` +
  `sandbox_mode = "danger-full-access"` (docker-or-mock only). Docker additionally passes
  `--dangerously-bypass-approvals-and-sandbox` (`codexLaunchCommand`): the container is already the
  security boundary and cannot create the unprivileged user namespace Codex's bundled bubblewrap
  needs, so leaving `workspace-write` active makes even a read-only planning command fail into a
  native approval selector. Root settings are rendered BEFORE installer-owned tables — appending
  `model` after `[plugins]` silently scopes it to that table.

- **The E2E test control plane is env-gated commands, not exported API** (`src/testControlPlane.ts`,
  `exposeTestControlPlane`, registered only when `PAIRETO_TEST=1`): `paireto.test.inspect` (state
  snapshot incl. `planTextForGate`) and `paireto.test.addComment` (disposable CommentController + the
  existing add-comment commands). `activate()` still returns void; zero product surface when unset.

- **RESOLVED E2E finding: OpenCode's post-hoc turn-end review opens on the native edit-tool signal.**
  OpenCode re-fires `message.updated` for the SAME user message at turn END, so the plugin's
  `userPromptSubmit` re-fired and reset `changedThisTurn` AFTER the turn's edits → the gate saw
  `false` and allowed the stop. Fix: forward a user `message.updated` as `userPromptSubmit` only on
  FIRST sight of its message id (`isNewUserTurn` + `seenUserMessages`). Edits are detected via the
  native `write`/`edit`/`apply_patch` `postToolUse` edge only — a `bash`-driven edit isn't seen
  (accepted; mitigate by model choice, no plugin-side git diff). Adapter pinned against opencode
  1.17.18 (tool ids `edit`/`write`/`apply_patch`, NOT `patch`).

- **Changes-list diffs open as PREVIEW tabs by default, but the internal re-point callers preserve
  the tab's prior preview/kept state** (`show.preview` on openDiff, captured via
  `locateReviewTab().preview`) — user-driven opens match the explorer/native git panel (safe for
  editable diffs: VS Code pins a preview tab the moment its document goes dirty), while
  reconcile-after-stage and per-tab Compare To must not downgrade a kept tab: VS Code keeps one
  preview per group, so reopening two kept diffs as previews collapses them into one recycled tab.
  The test harness (`.vscode-test.mjs`) opens a per-run mkdtemp fixture git workspace (a fixed
  shared path let concurrent runs rm-rf each other's live workspace) and sets `PAIRETO_TEST=1` so
  extension-host tests can drive the activated extension's real commands and assert internals via
  `paireto.test.inspect` (which now includes per-reason refresh counts).

- **Docker headless test runner (`docker/`) exists to keep VS Code windows off the macOS host.** Both
  suites launch a real Electron window; a Linux container + `xvfb` runs them headless. `PAIRETO_DOCKER=1`
  (set in compose) gates a `--no-sandbox`/`--disable-gpu` launch arg in BOTH runners (`.vscode-test.mjs`,
  `runE2E.ts`) — required because Electron runs as root with no usable Docker sandbox; inert on native
  macOS. The container is **persistent** (`command: sleep infinity`): `up -d --wait` boots it once (the
  entrypoint installs Linux deps + starts Xvfb, then `touch /tmp/paireto-ready` flips a compose
  healthcheck so `--wait` can't race the install), and the npm scripts `docker compose exec` each suite
  in — no rebuild/reboot per run. `node_modules` + `.vscode-test` are container-local named volumes (host
  macOS native binaries — esbuild/oxlint/oxfmt — and the macOS VS Code download can't be reused). Build
  context is `docker/` (only `entrypoint.sh` COPYed; repo bind-mounted). Gotchas the setup pins around:
  (1) **pnpm pinned to the host's 10.24.0** — corepack's default (pnpm 11) stopped honoring
  `onlyBuiltDependencies` and exits non-zero on the resulting "ignored build scripts"; (2) **Xvfb is
  started directly**, not via `xvfb-run` (its USR1 readiness handshake hangs in-container); (3) **Xvfb
  needs `-ac`** (disable X access control) — an exec'd client is a different session with no XAUTHORITY
  cookie, so without it Electron dies with "Authorization required" and SIGSEGVs; (4) **`DISPLAY=:99` is
  an image `ENV`** so exec'd commands (which skip the entrypoint) inherit it.
  - **E2E in Docker** adds `docker-compose.e2e.yml` (via `test:e2e:docker`): mounts codex/opencode auth
    from `$HOME` and a host-staged Claude secret. **Claude auth is auto-injected** — `prepare-e2e.sh`
    (host) extracts `~/.claude.json` + the keychain OAuth credential into gitignored `docker/.secrets`
    (mounted at `/paireto-secrets`); `buildClaudeHome`/`probeClaude` read them via `PAIRETO_CLAUDE_CONFIG`/
    `PAIRETO_CLAUDE_CREDENTIALS` (no manual `ANTHROPIC_API_KEY`, though it still wins if set). A selected
    driver that can't run (missing binary/auth) is a hard FAIL with the reason everywhere — native and
    Docker alike — never a silent skip (`fullflow.e2e.ts` throws; there is no skip path).

- **Provider-replay E2E routes the harness's LLM traffic through MockServer as a TRANSPARENT MITM
  forward proxy** (`src/e2e/mockserver/`), NOT via a base-URL/provider-config redirect and NOT between
  the harness and its hooks (the abandoned recorder). The harness keeps its real provider host + real
  OAuth token, so the SUBSCRIPTION records for ALL THREE harnesses (base-URL redirect couldn't record
  codex/opencode's OAuth); no CLIProxyAPI, no static-key upstream. Drivers just set HTTP(S)_PROXY/
  ALL_PROXY=MockServer + NODE_EXTRA_CA_CERTS/SSL_CERT_FILE=CA + NO_PROXY=localhost (`mockProxyEnv`);
  the CA is MockServer's fixed embedded cert, VENDORED at `src/e2e/mockserver/mockserver-ca.pem` (works
  in compose where the tests container has no docker). `PAIRETO_E2E_MODE=record` → `set_operating_mode
  CAPTURE` (proxy forwards+records) then `promote_recordings`+`raw_retrieve ACTIVE_EXPECTATIONS` (NOT
  `record_llm_fixtures` — it NPEs on proxy recordings) → normalize + commit. `check` → load fixture
  strict + `SIMULATE` (599 on miss, never forwards); `live` unchanged. All control is MCP-only
  (`McpClient` over `POST /mockserver/mcp`). Keep MockServer as the VCR engine: it owns transparent
  upstream capture, promotion, expectation storage/loading, strict misses, and replay. The host-side
  normalizing proxy is deliberately only a transport adapter around it (stable request match keys plus
  SSE header/EOF repair); replacing MockServer would mean rebuilding those VCR and MITM responsibilities,
  not merely removing an extra hop. Non-obvious pins (verified against the real image): the
  fixtures dir mounts at `/tmp/fixtures` (server file sandbox) for check's `load_expectations_from_file`;
  `stripVolatileRequestMatchers` reduces each matcher to `{method,path,body}` — else the recorded
  volatile Host/http2 headers 599 every replay; `normalizeRequestBodyFields` drops volatile body fields
  (Claude `metadata`+`system`). Validated end-to-end (record→snapshot→check→replay) against
  `mockserver-7.4.0`. Open risks (need a real harness+creds): codex rustls may ignore SSL_CERT_FILE
  (MITM CA trust), and check-mode auth seeding for codex/opencode.

- **The match key REDUCES the tool inventory, it never erases it (`normalizeToolInventory`).** Nulling
  `tools`/`mcp_servers` outright (and stripping every OpenCode tool's `parameters`) made replay blind
  to the one thing this project owns: a regression that stopped offering Paireto's tools, or shipped a
  broken schema for one, would still have matched and replayed green — and a broken
  `paireto_submit_plan` zod schema is a bug this repo has already shipped. So every tool keeps its
  NAME (sorted — order varies run to run), Paireto's own tools (`isPairetoTool`, matched loosely
  across `paireto_submit_plan` / `mcp__paireto__…` / `mcp__plugin_paireto_bridge__…`) are kept WHOLE
  (description and schema — both are this project's surface to the agent, and both are host-stable
  because they are literals in our own source), and every other tool is reduced to its name, because
  provider descriptions and built-in schemas churn each CLI release and can state the host OS/shell.
  **ONE normalizer serves every harness.** OpenCode originally had its own inline copy that deleted
  `parameters`/`description` in place and did NOT sort — so the very property the sort exists for
  (advertised order varies run to run) was missing on the one harness whose tools ride in the request
  body, leaving OpenCode replay able to 599 intermittently for a reason nothing would explain.

- **Every host a harness contacts must be in the proxy cert's SAN list, even ones the run does not
  need.** An unlisted host fails the TLS handshake, and a transport error is not the strict-replay
  599 the harness treats as a survivable miss — OpenCode hung with no inference traffic at all,
  intermittently, depending on whether it resolved its model catalogue from `models.dev` (listed) or
  `models.opencode.ai` (not). Changing `HOSTS` invalidates the machine-local identity, which
  `ensureTestCertificates` then regenerates on its own.

- **OpenCode npm-installs its plugin SDK AT RUNTIME, so a credential-free `check` run silently loses
  `paireto_submit_plan`'s schema — the E2E must pre-stage the SDK.** `check` has no network (strict VCR
  599s everything), so OpenCode's background `@opencode-ai/plugin` install fails, our plugin's dynamic
  `import` fails, and `planToolArgs()` fails open to `{}` — advertising the plan tool with NO `plan`
  parameter. The model then cannot submit a plan at all, and the only symptom is an unexplained "plan
  gate never opened" timeout. The Docker image pre-installs the SDK at `PAIRETO_OPENCODE_SDK`
  (`/opt/opencode-sdk`) and `OpenCodeDriver.stagePluginSdk` copies it into the temp config dir for BOTH
  mock modes, so record stops depending on npm too and the two exercise the same plugin surface.
  This was found only because the match key now KEEPS Paireto's own tool schemas
  (`normalizeToolInventory`): under the old blanket `delete parameters` the degraded schema was
  invisible. **The `planToolArgs()` fail-open remains a real product weakness** — a user whose SDK
  install fails (offline, proxy, registry outage) gets a silently useless plan tool.

- **`runE2E` exits explicitly on BOTH paths** (`main().then(exit 0).catch(exit 1)`). An unsettled
  teardown promise drains the event loop and Node exits **0 with the failure unreported** — a failing
  E2E that claims success. The trigger was the shim's `stop()`: `server.close()` waits for in-flight
  connections and a harness killed mid-request leaves some that never end, so `stop()` now calls
  `closeAllConnections()` and settles on a deadline. The explicit exit is the backstop for the whole
  class.

- **A strict-VCR miss reports a DIFF against the cassette entry it came closest to matching**
  (`src/e2e/bodyDiff.ts`). A miss is nearly always a small substitution inside a ~50KB body, so a
  digest, the body, or MockServer's own rendering of the unmatched request says nothing actionable —
  the changed lines do. The runner picks the entry for the same method+path sharing the longest
  prefix, pretty-prints both, and emits the differing hunks with context (capped, long lines
  truncated); the two-pointer walk resyncs after an inserted block so one insertion doesn't report
  everything after it as changed. MockServer's `docker logs` dump on teardown was removed — that was
  the wall of text this replaces.

- **Anything that makes the flow unable to complete ends the run at the cause, via
  `HarnessDriver.fatalError()`.** Waiting out a 120s step budget hides the reason in a log and blames
  whatever step happened to be waiting. All three drivers report: a TUI that exits mid-flow (the pane
  watch reads the keepalive's exit marker), OpenCode auto-rejecting a permission request
  (`openCodeRunFatal` — the agent blocks on a denied tool call and never retries), and an
  `opencode run` that exits without writing the implement marker (a plan-tool miss). Each fatal
  carries the offending line, and `screen()` prefixes it so the dump leads with the cause.

- **A tmux pane's keepalive is BOUNDED (900s) and stale `pai-e2e-*` servers are swept at launch.**
  The pane is held open past the TUI's exit so a startup failure stays capturable, but `dispose()`
  never runs when a run is killed — an unbounded keeper then leaks a live agent process (and its API
  session) for as long as it lasts. Observed: 16 orphaned servers, two alive over two hours, each
  holding a `claude` process.

- **A strict-VCR miss ends the run at the miss (`src/e2e/replayMiss.ts`).** The harness treats a 599
  as a transport error and retries the same unmatched request for tens of seconds, so the failure used
  to surface as whatever step was waiting on it — a 120s "plan gate never opened" timeout naming
  neither the endpoint nor the cassette. The shim now records the FIRST miss to a file the runner
  names (`PAIRETO_REPLAY_MISS_FILE`; the shim runs host-side, the test in the extension host), the
  test's step wait reads it and aborts, and `runE2E` prefers it over the version-drift hint. Scoped to
  the harness's own inference endpoints (the profile's `fixturePaths`): offline 599s on incidental
  traffic — a model catalogue, a package registry — are expected and survivable, and OpenCode's check
  passes with several.

- **An E2E run streams the agent's screen to stdout by default, and its tmux session is attachable
  read-only** (`src/e2e/drivers/watch.ts`, `PAIRETO_E2E_WATCH=0` to silence). The stream emits the
  lines past the longest common prefix with the previous capture (`newPaneLines`), so appended output
  appears once and a repainting TUI region re-emits as it changes; a whole check run is ~75 lines.
  The printed attach command uses `-r`, since a writable client shares the pane with the driver and a
  stray keystroke would land in the agent's prompt, and `launch()` pins `window-size manual` so
  attaching from a smaller terminal cannot reflow the pane the driver's screen reads depend on.

- **A driver's realism assertions must be phase-independent — never assert a permission MODE, because
  Paireto changes it by design.** The Claude driver answers the plan-file permission prompt with "1"
  (allow this edit), the way a user in plan mode would, and a background watcher checks the answer
  landed. The first version asserted "still in plan mode" afterwards and aborted a perfectly good run:
  approving a plan sets `nextMode` (auto/acceptEdits), so the footer legitimately stops saying "plan
  mode on". The invariant that actually holds in every phase is that the PROMPT DISMISSES — Claude
  blocks while one is pending, so a prompt still on screen after the budget means the answer didn't
  land and the agent is stuck. Fatals are reported via `HarnessDriver.fatalError()`, which the test's
  `wait` polls and turns into an immediate `StopPolling` abort instead of an unrelated step timeout.

- **Mock runs live under `/private/tmp` (`mockTmpRoot`) — the one root that is canonical on macOS AND
  creatable-canonical in the Linux container.** A sandbox at `/tmp/...` is spelled `/private/tmp/...`
  once macOS resolves it, so a cassette recorded in the container disagreed with a native run in the
  request bodies AND in the harness's own path checks: OpenCode rejected its own worktree as
  `external_directory` and the run died with no VCR miss at all. Normalizing the match key could never
  have fixed that — only a genuinely identical path could. This retired a pile of per-symptom
  workarounds and made native opencode/claudecode replay pass. Falls back to `/tmp` where `/private`
  can't be created, which costs cross-platform replay but keeps the run working.

- **A cassette records the PLATFORM it was captured on (`recordedOn`, checked like the version
  stamp).** With paths solved the remaining divergence is host-specific COMMAND OUTPUT: an agent that
  verifies its work with `od` gets BSD column padding on macOS and GNU's on Linux, and that output is
  fed back as the next request. It is content the model reasons about, so normalizing it would
  falsify the recording. Native claudecode/opencode replay; native codex does not. Docker stays
  authoritative and the stamp explains a native mismatch up front.

- **A cassette must replay on a DIFFERENT machine than it was recorded on, so host-dependent content
  is normalized too.** Recordings are made in the Linux container; a native macOS `e2e:check` differs
  in ways that have nothing to do with Paireto: OpenCode's built-in tool descriptions state the host
  OS and shell (`OS: darwin, Shell: zsh`), and Codex's `<skills_instructions>` enumerates whichever
  SKILL.md files that host can see, with their locators. Both are dropped/normalized; Paireto's own
  tool descriptions and schemas are still matched. Separately, `PAIRETO_OPENCODE_SDK` only exists in
  the image, so `stagePluginSdk` also falls back to the user's own opencode config `node_modules` —
  without it a native check silently loses `paireto_submit_plan`'s `plan` parameter. Native codex and
  opencode checks had never been run before this and failed on all three counts.

- **Per-run identifiers in a request body must be renumbered, not blanked** (`canonicalizeItemIds`).
  Codex stamps a fresh `msg_<uuidv7>` on every conversation item plus `call_id`s pairing a tool call
  with its output, so a replayed body can never match verbatim. Blanking them all to one value would
  lose the pairing, so each distinct id maps to `paireto-id-<n>` in first-appearance order: distinct
  ids stay distinct, the pairing survives, the run-specific value goes. This surfaced only after the
  strict-miss fail-fast made the failure legible.

- **A check run's request is not identical to the record run's, so the match key must be insensitive
  to environment-dependent COUNTS, not just contents.** Empirically: a credential-free `check` run
  gets ONE FEWER `<system-reminder>` in Claude's first user message than the subscription `record`
  run. Stripping each reminder's text left an EMPTY content block behind, so the content array's
  LENGTH still encoded the reminder count and every replay 599'd on the very first conversation turn
  (the title-generation request matched, so the failure looked like a plan-gate timeout, not a VCR
  miss). `dropEmptyTextBlocks` removes blank text blocks after the strip. Debug aid for the next one:
  `PAIRETO_SHIM_DUMP=<dir>` makes the shim write each normalized match key to a file, so it can be
  diffed against the cassette's — that's how this was found.

- **Identity scrubbing is two-sided and backed by a scan, not a denylist.** `promote_recordings`'
  redaction and the response-header whitelist only cover headers/cookies, so a provider endpoint that
  returns the recorder's email/account id in its BODY (Codex's usage endpoint does) got committed
  verbatim. Requests are scrubbed inside `normalizeRequestBody` (`scrubIdentity`) so the cassette and
  the live request are scrubbed IDENTICALLY and matching is unaffected; responses are scrubbed at
  write time (`scrubCapturedResponses`) since they're never matched on. The GUARANTEE is
  `fixturePrivacy.test.ts`, which scans every committed cassette for anything email- or account-id-
  shaped — a denylist always misses the next new field, a scan doesn't.

- **Cassettes are stamped with the harness version they were recorded against
  (`{recordedWith, expectations}`) and the stamp is REQUIRED — no legacy bare-array shape.** The
  Docker image installs the agent CLIs UNPINNED on purpose — running against latest is the point — so
  harness drift is expected, and a strict-VCR miss otherwise surfaces as an opaque step timeout.
  `readFixture` rejects an unstamped cassette (or one stamped for a different driver) with a
  re-record instruction, and `record` refuses to WRITE one when it can't read the CLI version:
  tolerating an unstamped file would reintroduce the exact opaque failure the stamp exists to
  explain. `prepareCheck` compares the stamp to the installed CLI and `runE2E` appends the resulting
  `versionDriftNote` to any failure ("recorded with X, running Y — re-record").

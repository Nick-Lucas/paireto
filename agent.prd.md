# Paireto — Product Requirements

## What it is

A VS Code extension + bundled agent bridge plugins that bring terminal-first AI coding (Claude Code,
Codex, or OpenCode in a terminal) into the VS Code UI — without replacing the TUI. You keep driving
the agent in the terminal; VS Code gives you visibility and PR-style review surfaces.

## Goals

- See connected agents and their activity at a glance.
- Review and approve/redirect plans in the editor instead of the terminal.
- Review code changes PR-style (diffs + inline comments) and send that feedback straight to the agent.
- Browse working changes with native-git-panel ergonomics any time.
- Switch repos/worktrees quickly.

## Non-goals

- Not a replacement for the Claude Code TUI.
- Not a full Git client or GitHub PR replacement.
- No telemetry/transcript capture; no terminal scraping.

---

## Architecture (one line)

VS Code extension ⇄ per-repo Unix domain socket ⇄ a per-harness bridge plugin (hooks/events, plus an
MCP server or custom tools where the harness supports them). Sessions are correlated by repository
directory, not terminal.

---

## Supported agents

Three harnesses connect through the same socket protocol; a per-harness `AgentStrategy` maps each
one's events into the common model. Claude Code is the reference (full feature set); Codex and
OpenCode reach it where the harness allows and degrade gracefully where it doesn't.

| Capability | Claude Code | Codex | OpenCode |
|---|---|---|---|
| Live status / agent list | yes | yes (TUI; awaiting-permission is TUI-only) | yes |
| Turn-end blocking review | yes | yes | post-hoc — not parked; Send Feedback auto-resumes the idle agent |
| Plan review | yes, auto (ExitPlanMode) | at Stop-in-plan-mode (detected via the rollout transcript); plan text = the transcript's Plan-item markdown; approve unblocks the Stop but the implement/stay choice stays in the TUI | yes, automatic (plugin-injected planning prompt + `paireto_submit_plan` tool) |
| Approve → auto mode switch | yes | no | yes (agent switch; default `build`) |
| False-turn-end protection | subagents + background counts | subagent events only | child-session tracking |
| Process-death cleanup | MCP liveness | MCP stdio liveness (instant when attached; 30-min silence sweep backstop) | plugin socket drop |
| Session-end telemetry | yes | no (no SessionEnd hook) | yes (session.deleted) |
| Install | marketplace CLI | `hooks.json` merge + auto-trust hash | global plugin file copy |

Setup notes:
- **Claude Code:** install the bundled plugin via the marketplace CLI, restart to load hooks + MCP.
- **Codex:** the installer merges hooks into `~/.codex/hooks.json`, writes the trust hashes into
  `~/.codex/config.toml`, and ensures `[features] hooks = true` there (Codex's master switch — no
  hook runs without it), so hooks go live immediately across all repos with no approval step. If the
  user has explicitly set `hooks = false`, setup leaves it and surfaces that instead of flipping it;
  fail-open if a Codex release changes the (undocumented) hash algorithm.
- **OpenCode:** the installer copies one global plugin file (autoloaded for every repo) plus a
  `paireto-review` command — zero further setup. The plugin instructs the agent itself: a `config`
  hook scopes `paireto_submit_plan` to planning agents, a system-prompt transform tells a planning
  session to submit its plan through it, and turn-end review is post-hoc (a `session.idle` gate that
  injects Send-Feedback as a fresh turn, since OpenCode can't park an idle agent). Approving a plan
  switches to the target agent (`build` by default).

---

## Features

### Agents
- Live list of connected agent sessions **across every workspace and Git root in the window**, with status (idle /
  thinking / running tool / awaiting plan / awaiting permission). Rows awaiting a gate show which kind
  (plan/code review) and whether it's foreground (active) or pending. Subagent activity is not tracked
  at all — only the top-level agent's status is shown.
- Each row is labelled by the harness name + short session id (`Claude (a1b2c3d4)`), so agents in one
  repo are distinguishable; the repo, start time, and current/last tool are in the tooltip.
- Status bar item showing current repo · branch + agent activity.
- Activity-bar **badge** ("ticker") on the Paireto icon: a count of changed files (like the Git tab).
  Agent "needs you" cues are not in the badge — VS Code's badge is numeric/theme-coloured only — they
  stay on the colourable surfaces (status bar, agent rows, switcher).
- Clicking an agent row switches its pending plan/review to the foreground (or focuses the terminal
  if it has none); a "Focus Agent" button focuses the terminal directly. Clicking also clears the
  row's "needs you" marker.
- **Needs-you alert:** when an agent enters a state that wants the user — finished a turn (Stop),
  awaiting permission, awaiting plan approval, or a `Notification` (Claude asking a question / waiting
  for input) — an orange bell appears on the agent row (and in the status bar + repo switcher), and
  once per transition a sound plays (`paireto.notify.type` =
  `sound` (default, sound from `paireto.notify.sound`) or `disabled`). Only this window's agents
  alert. A Stop that lands while background (child) agents are still running is ignored — the agent
  emits a final Stop once they finish, which alerts normally — and informational `Notification`s
  (e.g. auth success) never alert.
- **Hide/show an agent:** an eye icon on each row mutes it — the row stays listed showing just the
  agent name with a crossed-eye icon (no status text), stops pinging (no sound/bell), and is excluded
  from needs-you aggregates (status bar, switcher, published activity). Toggle back on to re-enable;
  row click behaviour is unchanged.
- Stuck-state safety net: an agent that goes silent after an un-hookable interrupt is auto-cleared;
  an agent whose process is killed (no SessionEnd hook fires) is detected via a liveness connection
  the plugin's MCP server holds open, and dropped from the list immediately.

### Repo / Worktree Switcher
- `Cmd/Ctrl+Shift+K` (or status bar click) opens a picker: current window, worktrees, recent repos.
- Rows are labelled branch-first (directory as the secondary description) and deduped by canonical
  path (Current > Worktrees > Recents), so a worktree that's also a recent — or a symlinked path —
  shows once. Recent-repo branches are fetched live when the picker opens.
- Enter opens in a new window; `Shift+Enter` opens in the current window.
- Each row summarises that location's agent activity and whether it has an open window: `no window`,
  `open · idle`, a live state (`thinking · 2 agents`, `plan review`, …), or `needs you`. The data
  comes from per-repo activity files each window publishes (there's no cross-window VS Code API).

### Plan & Code Review (shared gate)
Plan Review and Code Review are two surfaces over one shared "gate". Several agents' gates can be
**pending at once**, but only **one is foreground** (occupying the editor/comment surfaces) at a
time — the others wait, unresolved, until brought forward. Both gather kinded line comments, and both
resolve with the same two actions.
- **Two actions (colored icons):** **Approve** (green) → agent proceeds; **Send Feedback** (amber) →
  deny-with-feedback (plan: agent revises; review: agent acts on the comments). No Reject — Send
  Feedback covers it. Only the relevant one shows: **Approve** until any feedback is queued, then
  **Send Feedback**.
- Line comments tagged Question / Comment / Problem; **comments are editable and deletable** after
  creation (edit/save/delete on the comment). The author is the VS Code signed-in account, else the OS
  login name, else "Developer".
- **Switch between agents:** the Agents section is window-wide and shows
  which agents are awaiting which gate (plan vs review) and which is foreground vs pending. Clicking
  an agent brings its gate to the foreground (backgrounding the current one without resolving it), so
  you can flip between several pending plans/reviews and come back. At most one review is pending at a
  time; multiple plans can be.
- **Disconnect resets state:** if the agent side ends another way (interrupt, crash, ExitPlanMode
  resolved in the terminal), the dropped connection auto-closes the plan/review and resets the UI.
- **Bottom panel:** hidden while any gate (plan or review) is foreground, restored once none is.
- **Sidebar focus + notification on auto-start:** whenever a plan or review opens automatically, the
  Paireto sidebar is focused and a (non-blocking) notification explains what happened with quick
  actions — plan: **View Plan** / **Approve Immediately**; review: **Start Reviewing** / **Approve
  Immediately**. `/paireto-review` never notifies.

### Plan Review
- When the agent finishes a plan (ExitPlanMode), the plan opens in VS Code automatically, the bottom
  panel (terminal) is hidden, and the agent blocks waiting for a decision. The plan tab is named
  `PLAN: <first line of the plan> - <datetime>`.
- On any resolution the plan tab auto-closes and the terminal panel is restored.
- Closing the plan tab while it's still pending prompts you to Approve or Send Feedback (dismiss to
  keep reviewing).
- Approving puts the agent into **auto** mode by default so it proceeds without re-prompting
  (`paireto.planApprove.mode.claudecode` — enum `auto` / `acceptEdits` / `default` / `plan` / `off`,
  default `auto`; `paireto.planApprove.mode.opencode` — the agent to switch to, default `build`,
  `off` to stay put. Codex has no settable mode, so no key).

### Code Review
- **Comment any time:** open any Changes-section diff and add inline comments (Question / Comment /
  Problem) without starting anything — comments collect in an unclaimed bucket and reveal the Feedback
  section. They don't start a review; the next review (turn-end or `/paireto-review`) consumes them.
  Commenting works whether or not the diff is editable; editability is purely structural (editable
  when the file has no lower-level change, locked otherwise) and a review never changes it.
- **Durable comment links:** each sidebar comment remembers the Git layer and pinned comparison where
  it was created. Revealing it prefers that exact layer when a path is both staged and unstaged,
  follows later staging/unstaging/commits and detected renames, and relocates the live thread using
  its saved quote plus surrounding context. If the code was rewritten or removed, the comment stays
  attached at a safe nearby/current or historical location rather than being discarded.
- **Resolved at turn-end:** when the agent finishes a turn in which it edited files (detected via the
  `PostToolUse` edit-tool hook), or you've left comments, it parks in review mode until you act —
  **Send Feedback** delivers your comments, **Approve** lets it finish with nothing sent. Nothing is
  ever sent without an explicit Send Feedback; a turn that edited nothing (and has no comments) is
  never delayed. Auto-parking on edits is governed by `paireto.review.mode` (`automatic` default /
  `manual`); in `manual`, only queued comments or `/paireto-review` open a review.
- **Manual `/paireto-review`:** still available — opens a blocking review session in VS Code and waits;
  Send Feedback returns the comments, Approve proceeds with no changes.

### Changes View (always available)
- Native-git-panel-style list of working changes, grouped top-down by git layer: **Committed**,
  **Staged**, **Working Tree**.
  - Committed = files changed since the Compare-To point that aren't already staged/unstaged.
  - Each group title row shows a coloured layer icon plus a muted `N files · +adds -dels` indicator.
- A single Git repository keeps the compact layout above. With multiple detected repositories, the
  view adds an expanded folder row per repository (including clean repositories), labelled with its
  ending directory name, current branch as the secondary label, and an absolute-path tooltip; each
  row owns its Committed / Staged / Working Tree groups. Nested repositories and submodules remain
  separate roots. The shared comparison target remains on the Changed Files section row.
- **Compare To** presets (HEAD, merge-base, default branch (main/master auto-detected), recent refs,
  or any branch/ref via picker) and the **Flat / Tree** layout toggle are inline buttons on the
  Changed Files section row. Every open virtual review file also has its own **Compare To** title
  action (Index, HEAD, merge-base, default branch, recent ref, or any branch/ref); this changes only
  that tab's pinned baseline. Both pickers initially highlight their current value; an arbitrary
  current ref is included explicitly when it is not already a preset/recent item.
- In a multi-repository view, Compare To is one semantic window-wide choice: HEAD, merge-base, or
  default branch. Each repository resolves that preset independently. Custom/recent refs remain
  available in the single-repository picker because a ref is not reliably meaningful across repos.
- Per-file: open changes (row click), open file (first inline button on every row), stage, unstage,
  discard (confirm) + right-click menu.
- Browsing diffs are **editable with full LSP** when the file has no change at a lower level
  (committed > staged > unstaged): the modified side is the real working-tree file, so edits land in
  the unstaged level and the view refreshes on save. The first edit to a staged/committed file moves
  its sidebar location to Working Tree but never changes the diff's baseline: the tab continues to
  compare against the ref/index it opened with until the user explicitly changes it. The tab title
  names that baseline. Diffs stay read-only for deleted files and whenever a lower-level change makes
  editing ambiguous.
- Per-folder (tree layout): stage / unstage / discard every change under the folder, via the same
  inline buttons — matching the native git panel.
- The tree selection follows the diff in focus: opening a file or switching between open diff tabs
  selects its row, and when an edit moves a staged/committed file to the working tree, the Unstaged
  row is highlighted as it appears.
- Group-level: Stage All, Unstage All, Discard All.
- Git controls apply to Staged/Unstaged; the Committed group is read-only.

### Sidebar
- One "Paireto" view with collapsible sections: Agents, Changed Files (always), Plan Review
  (while a plan is pending), Feedback (during a review session). Section controls live on their
  section rows / the title bar; the shared gate actions use colored icons whenever a plan or review is
  active — **Approve** (green) until feedback is queued, then **Send Feedback** (amber).
- The sidebar inventory is stable while navigating files: changing the active editor does not switch
  its repository context. The status bar and repo/worktree switcher remain active-repository views.
- Commands exposed in the Command Palette or parent editor UI use the `Paireto: ` prefix; actions
  shown only inside Paireto comment boxes or tree context menus keep concise local labels. The
  comment-controller gutter action is parent UI and remains `Paireto: Add Comment`.

### Welcome / Onboarding
- A Welcome webview opens **once on first install** (and via **Paireto: Open Welcome**). Two sections:
  - **Set up your agent:** each agent is a card with stacked setup steps, each with its own status +
    action — **Bridge plugin** (Set up / Update / ✓ Installed — Update re-runs the idempotent
    installer to move a stale version to the shipped one; unsupported agents tagged "Planned") and
    **Terminal profile** (Configure / ✓ Configured), which adds the agent's
    profile (e.g. `claudecode`) to User settings to power the quick-launch new-terminal-with-profile
    picker.
  - **The Paireto way:** recommended keyboard shortcuts for the terminal-first workflow (focus
    terminal, toggle bottom bar, fullscreen terminal, switch terminal tabs, quick-launch a TUI agent
    via `newWithProfile`, open the Paireto tab). These are all **built-in VS Code commands**; each row shows its command id
    (click to view it in Keyboard Shortcuts) and a **Set** button (or **Set all**) that writes the
    recommended key — and any required default removals — to the user's `keybindings.json`. An **Edit
    Keybindings** button opens the Keyboard Shortcuts UI.

---

## Core workflows

**Plan approval**
1. Agent presents a plan → it opens in VS Code (terminal panel hidden), agent waits.
2. You read it, optionally comment (comments are editable).
3. Approve (agent continues, in auto mode by default) or Send Feedback (agent revises). The tab
   auto-closes and the terminal returns.

**Code review**
1. Comment on the diffs whenever you like (the first comment starts a review), or run `/paireto-review`
   for a blocking session on demand.
2. When the agent finishes a turn that changed files, it parks in review mode until you act.
3. Send Feedback (agent applies the comments) or Approve (agent proceeds with no changes).

**Browse changes**
1. Open the Changes section any time.
2. Pick a Compare-To point; switch flat/tree.
3. Stage / unstage / discard / open diffs like the native git panel.

**Switch context**
1. `Cmd/Ctrl+Shift+K`.
2. Pick a worktree or recent repo; open in this or a new window.

---

## Setup

- Install the VS Code extension; it opens the Welcome screen once, where you set up the bundled
  Claude Code plugin per agent (manual fallback available) and apply recommended keybindings.
- Restart Claude Code so hooks + the MCP tool load.
- Requires: VS Code, Claude Code, git.

## Testing

- **Unit tests** (`pnpm test`) cover the framework, mappers, installers, and gate semantics.
- **E2E** (`pnpm test:e2e`, `src/e2e/`) drives the whole plan → feedback → approve → implement →
  review loop inside a real VS Code window over the per-repo socket (never terminal scraping).
  `PAIRETO_E2E_DRIVER=claudecode|codex|opencode` runs the real harness TUI in an isolated temp home
  (real LLM calls, cents per run); a missing binary/auth SKIPs (never fails). All three harnesses
  pass the full five-step flow — see `src/e2e/README.md` for setup.

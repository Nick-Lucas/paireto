# TUI Companion — Key Decisions

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

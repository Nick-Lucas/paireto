# TUI Companion — Key Decisions

- **Plugin TS dev scripts get their own tsconfig.** `plugins/claude-code/scripts/*.ts` (e.g. the
  bridge emulator) run directly on Node's type-stripping and live outside the extension's
  `rootDir: "src"`. They're type-checked via `plugins/claude-code/tsconfig.json` (noEmit), which
  `check-types` runs after the root build. Don't add `plugins` to the root tsconfig `include` —
  it breaks `compile-tests`' `out/` layout (the test runner globs `out/test/**`).

- **Editable diffs use the real working-tree file as the modified side.** That gives LSP + editing
  for free and routes edits to the unstaged (lowest) level. A file is editable only when it has no
  change at a lower level (committed > staged > unstaged) and isn't deleted. Diffs stay virtual
  (`tui-review` scheme) during a `/tui-review` session because the comment controller only attaches
  to that scheme — editing and commenting can't share a diff side. The first edit to a
  staged/committed editable diff (detected via `onDidChangeTextDocument` + the active
  `TabInputTextDiff`) re-targets the base to the index so it becomes the unstaged diff against the
  live dirty buffer; the edited (now-dirty, non-preview) higher-level tab is closed so the unstaged
  diff replaces it, and the caret is restored from a deferred read (the editor selection updates
  *after* `onDidChangeTextDocument`, so reading it synchronously is off-by-one). A per-repo
  `FileSystemWatcher` (`**/*`, debounced 200ms, .git/node_modules skipped) refreshes the Changes view
  and re-fetches any open `tui-review` diff sides for changed paths, so external/agent edits show up.

- **Folder rows reuse the file stage/unstage/discard commands.** Tree folders carry their
  `FileGroup` so the contextValue is `folder:<group>`; the command handlers flatten a folder node to
  all descendant files (`filesInEntry`). Committed folders/files are read-only (no git buttons).

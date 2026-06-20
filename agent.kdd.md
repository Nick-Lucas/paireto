# TUI Companion — Key Decisions

- **Plugin TS dev scripts get their own tsconfig.** `plugins/claude-code/scripts/*.ts` (e.g. the
  bridge emulator) run directly on Node's type-stripping and live outside the extension's
  `rootDir: "src"`. They're type-checked via `plugins/claude-code/tsconfig.json` (noEmit), which
  `check-types` runs after the root build. Don't add `plugins` to the root tsconfig `include` —
  it breaks `compile-tests`' `out/` layout (the test runner globs `out/test/**`).

- **Folder rows reuse the file stage/unstage/discard commands.** Tree folders carry their
  `FileGroup` so the contextValue is `folder:<group>`; the command handlers flatten a folder node to
  all descendant files (`filesInEntry`). Committed folders/files are read-only (no git buttons).

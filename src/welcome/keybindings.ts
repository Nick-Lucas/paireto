// Reading + writing the user's keybindings.json for the Welcome screen's "Paireto way" section.
// The keybindings we manage are all built-in VS Code commands; "set recommended" appends/updates an
// entry in the user file (user bindings win over defaults). VS Code exposes no API to read effective
// keybindings, so we read user *overrides* from the file and fall back to a small known-defaults table
// for display. The pure functions here are unit-tested; the vscode-facing I/O lives in WelcomePanel.

import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";

/**
 * A default binding that must be *removed* from the recommended key for the shortcut to work cleanly
 * (written as a `-command` entry on the same key). E.g. binding `ctrl+shift+\`` to `newWithProfile`
 * needs the default `terminal.new` removed off that key.
 */
export interface RemoveDefault {
  command: string;
  when?: string;
}

/** One row in the "Paireto way" list — a built-in command we offer to (re)bind. */
export interface ManagedShortcut {
  /** Stable row id used in webview messages. */
  id: string;
  /** Human label shown in the UI. */
  label: string;
  /** The command to bind. */
  command: string;
  /** Recommended key on macOS (e.g. "cmd+'"). */
  macKey: string;
  /** Recommended key on Windows/Linux (e.g. "ctrl+'"). */
  otherKey: string;
  /** Optional `when` clause. */
  when?: string;
  /** Known VS Code default key (mac) for display when the user hasn't overridden it. */
  defaultMacKey?: string;
  /** Known VS Code default key (other) for display when the user hasn't overridden it. */
  defaultOtherKey?: string;
  /** Default bindings to remove off the recommended key when applying this shortcut. */
  removeDefaults?: RemoveDefault[];
}

/** A single entry in a keybindings.json array. */
export interface KeybindingEntry {
  key?: string;
  command?: string;
  when?: string;
  args?: unknown;
}

export type Platform = "mac" | "other";

/** The shortcuts the Welcome screen manages — all built-in VS Code commands. */
export const MANAGED_SHORTCUTS: ManagedShortcut[] = [
  {
    id: "focus-terminal",
    label: "Focus terminal",
    command: "workbench.action.terminal.focus",
    macKey: "cmd+'",
    otherKey: "ctrl+'",
  },
  {
    id: "toggle-panel",
    label: "Toggle bottom bar",
    command: "workbench.action.togglePanel",
    macKey: "cmd+j",
    otherKey: "ctrl+j",
    defaultMacKey: "cmd+j",
    defaultOtherKey: "ctrl+j",
  },
  {
    id: "fullscreen-terminal",
    label: "Toggle fullscreen terminal",
    command: "workbench.action.toggleMaximizedPanel",
    macKey: "cmd+shift+=",
    otherKey: "ctrl+shift+=",
    when: "panelAlignment == 'center' || panelPosition != 'bottom' && panelPosition != 'top'",
    // shift+cmd+= / ctrl+shift+= is "zoom in" by default — clear it so the key maximizes the panel.
    removeDefaults: [
      { command: "workbench.action.zoomIn" },
      {
        command: "workbench.action.browser.zoomIn",
        when: "browserFocused && browserHasUrl && !browserHasError && activeEditor == 'workbench.editor.browser'",
      },
    ],
  },
  {
    id: "terminal-tab-prev",
    label: "Switch terminal tab (previous)",
    command: "workbench.action.terminal.focusPrevious",
    macKey: "cmd+shift+[",
    otherKey: "ctrl+shift+[",
    when: "terminalFocus",
    // `cmd+shift+[` is the VS Code mac default for this command (when terminalFocus) — so on mac it's
    // already bound and we shouldn't prompt. Win/Linux defaults differ (≈ctrl+pageup) and are left
    // unset, so there we still offer the recommended binding.
    defaultMacKey: "cmd+shift+[",
  },
  {
    id: "terminal-tab-next",
    label: "Switch terminal tab (next)",
    command: "workbench.action.terminal.focusNext",
    macKey: "cmd+shift+]",
    otherKey: "ctrl+shift+]",
    when: "terminalFocus",
    defaultMacKey: "cmd+shift+]",
  },
  {
    id: "quick-launch",
    label: "Quick-launch a TUI agent (new terminal with profile)",
    // newWithProfile opens the terminal-profile picker, so you can launch a profile that runs an agent.
    command: "workbench.action.terminal.newWithProfile",
    macKey: "ctrl+shift+`",
    otherKey: "ctrl+shift+`",
    // ctrl+shift+` is "new terminal" by default — clear it so the key launches via profile instead.
    removeDefaults: [
      {
        command: "workbench.action.terminal.new",
        when: "terminalProcessSupported || terminalWebExtensionContributedProfile",
      },
    ],
  },
  {
    id: "open-paireto-tab",
    label: "Open Paireto tab",
    // The auto-generated focus command for the Paireto activity-bar view container.
    command: "workbench.view.extension.paireto",
    macKey: "cmd+shift+c",
    otherKey: "ctrl+shift+c",
    // cmd+shift+c / ctrl+shift+c is "Open New External Terminal" by default — clear it.
    removeDefaults: [{ command: "workbench.action.terminal.openNativeConsole" }],
  },
];

/** Recommended key for a shortcut on the given platform. */
export function recommendedKey(s: ManagedShortcut, platform: Platform): string {
  return platform === "mac" ? s.macKey : s.otherKey;
}

function knownDefault(s: ManagedShortcut, platform: Platform): string | undefined {
  return platform === "mac" ? s.defaultMacKey : s.defaultOtherKey;
}

/**
 * Parse keybindings.json text (JSONC — comments + trailing commas tolerated) into entries.
 * Returns [] on an empty file or unrecoverable parse, so callers can still write.
 */
export function parseKeybindings(text: string): KeybindingEntry[] {
  if (!text.trim()) {
    return [];
  }
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true });
  return Array.isArray(value) ? (value as KeybindingEntry[]) : [];
}

/**
 * Normalize a key string for comparison: lower-case, whitespace-insensitive, and **modifier-order
 * insensitive**. VS Code canonicalizes modifier order when it stores a binding (e.g. our `cmd+shift+=`
 * becomes `shift+cmd+=`), so we sort the tokens within each chord before comparing. Chord *sequence*
 * (space-separated, e.g. `cmd+k cmd+s`) is preserved.
 */
function normalizeKey(key: string | undefined): string {
  return (key ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s*\+\s*/g, "+") // collapse spaces around `+` so chords split on whitespace cleanly
    .split(/\s+/)
    .map((chord) =>
      chord
        .split("+")
        .map((t) => t.trim())
        .filter(Boolean)
        .sort()
        .join("+"),
    )
    .join(" ");
}

/**
 * The user's *override* binding for a command, if any (ignores VS Code-default-removing `-command`
 * entries). The last matching positive entry wins, mirroring VS Code's "later wins" resolution.
 */
export function userBinding(
  entries: KeybindingEntry[],
  command: string,
): KeybindingEntry | undefined {
  let found: KeybindingEntry | undefined;
  for (const e of entries) {
    if (e && e.command === command && e.key) {
      found = e;
    }
  }
  return found;
}

/**
 * The effective current key for display: the user override if present, otherwise the known VS Code
 * default (when we have one). Returns undefined when neither is known.
 */
export function effectiveBinding(
  entries: KeybindingEntry[],
  s: ManagedShortcut,
  platform: Platform,
): { key: string; source: "user" | "default" } | undefined {
  const override = userBinding(entries, s.command);
  if (override?.key) {
    return { key: override.key, source: "user" };
  }
  const def = knownDefault(s, platform);
  return def ? { key: def, source: "default" } : undefined;
}

/** True when a `-command` removal entry for `rd` exists on the recommended key. */
function removalApplied(
  entries: KeybindingEntry[],
  recommendedNorm: string,
  rd: RemoveDefault,
): boolean {
  return entries.some(
    (e) => e && e.command === `-${rd.command}` && normalizeKey(e.key) === recommendedNorm,
  );
}

/**
 * True when the shortcut is fully applied: the recommended key resolves to its command AND every
 * required default removal is present. Missing removals keep it "not set" so Set re-applies them.
 */
export function isApplied(
  entries: KeybindingEntry[],
  s: ManagedShortcut,
  platform: Platform,
): boolean {
  const recNorm = normalizeKey(recommendedKey(s, platform));
  const current = effectiveBinding(entries, s, platform);
  if (!current || normalizeKey(current.key) !== recNorm) {
    return false;
  }
  return (s.removeDefaults ?? []).every((rd) => removalApplied(entries, recNorm, rd));
}

/** A snapshot of how one shortcut resolves — for the shared "Paireto" log channel. */
export interface ShortcutDebug {
  command: string;
  recommended: string;
  recommendedNorm: string;
  defaultKey?: string;
  /** Every keybindings.json entry that targets this command (any key, including `-command` removals). */
  matchingEntries: { key?: string; when?: string; norm: string }[];
  /** Per required removal: the command and whether its `-command` entry is present on the rec. key. */
  removals: { command: string; applied: boolean }[];
  effective?: { key: string; source: "user" | "default" };
  isApplied: boolean;
}

export function debugShortcut(
  entries: KeybindingEntry[],
  s: ManagedShortcut,
  platform: Platform,
): ShortcutDebug {
  const rec = recommendedKey(s, platform);
  const recNorm = normalizeKey(rec);
  return {
    command: s.command,
    recommended: rec,
    recommendedNorm: recNorm,
    defaultKey: knownDefault(s, platform),
    matchingEntries: entries
      .filter((e) => e && e.command === s.command)
      .map((e) => ({ key: e.key, when: e.when, norm: normalizeKey(e.key) })),
    removals: (s.removeDefaults ?? []).map((rd) => ({
      command: rd.command,
      applied: removalApplied(entries, recNorm, rd),
    })),
    effective: effectiveBinding(entries, s, platform),
    isApplied: isApplied(entries, s, platform),
  };
}

export interface UpsertSpec {
  command: string;
  key: string;
  when?: string;
}

/**
 * Add or update the keybinding for a command in keybindings.json text, preserving comments and
 * formatting (via jsonc-parser edits). If a positive entry for the command already exists, its key
 * (and when) is updated in place; otherwise a new entry is appended.
 */
export function upsertBinding(text: string, spec: UpsertSpec): string {
  const source = text.trim() ? text : "[]";
  const errors: ParseError[] = [];
  const root = parse(source, errors, { allowTrailingComma: true });
  const arr: KeybindingEntry[] = Array.isArray(root) ? (root as KeybindingEntry[]) : [];

  const index = arr.findIndex((e) => e && e.command === spec.command && e.key);
  const entry: KeybindingEntry = { key: spec.key, command: spec.command };
  if (spec.when) {
    entry.when = spec.when;
  }

  const formattingOptions = { tabSize: 2, insertSpaces: true };
  const path = index >= 0 ? [index] : [arr.length];
  const edits = modify(source, path, entry, { formattingOptions });
  return applyEdits(source, edits);
}

/**
 * Apply a managed shortcut to keybindings.json text: write the positive binding on the recommended
 * key, then a `-command` removal entry on that same key for each required default removal. Idempotent.
 */
export function applyShortcut(text: string, s: ManagedShortcut, platform: Platform): string {
  const key = recommendedKey(s, platform);
  let out = upsertBinding(text, { command: s.command, key, when: s.when });
  for (const rd of s.removeDefaults ?? []) {
    out = upsertBinding(out, { command: `-${rd.command}`, key, when: rd.when });
  }
  return out;
}

// Unit tests for the Welcome screen's keybindings.json read/write logic (pure functions, no vscode).

import * as assert from "node:assert";

import {
  type KeybindingEntry,
  MANAGED_SHORTCUTS,
  type ManagedShortcut,
  applyShortcut,
  effectiveBinding,
  isApplied,
  parseKeybindings,
  recommendedKey,
  upsertBinding,
  userBinding,
} from "../welcome/keybindings.js";

const focusTerminal: ManagedShortcut = {
  id: "focus-terminal",
  label: "Focus terminal",
  command: "workbench.action.terminal.focus",
  macKey: "cmd+'",
  otherKey: "ctrl+'",
};

const togglePanel: ManagedShortcut = {
  id: "toggle-panel",
  label: "Toggle bottom bar",
  command: "workbench.action.togglePanel",
  macKey: "cmd+j",
  otherKey: "ctrl+j",
  defaultMacKey: "cmd+j",
  defaultOtherKey: "ctrl+j",
};

const fullscreenTerminal: ManagedShortcut = {
  id: "fullscreen-terminal",
  label: "Toggle fullscreen terminal",
  command: "workbench.action.toggleMaximizedPanel",
  macKey: "cmd+shift+=",
  otherKey: "ctrl+shift+=",
};

const terminalTabPrev: ManagedShortcut = {
  id: "terminal-tab-prev",
  label: "Switch terminal tab (previous)",
  command: "workbench.action.terminal.focusPrevious",
  macKey: "cmd+shift+[",
  otherKey: "ctrl+shift+[",
  when: "terminalFocus",
};

suite("welcome keybindings", () => {
  test("parseKeybindings tolerates comments, trailing commas, and empty input", () => {
    assert.deepStrictEqual(parseKeybindings(""), []);
    assert.deepStrictEqual(parseKeybindings("   \n  "), []);
    const text = `// my bindings
[
  // focus
  { "key": "cmd+k", "command": "foo", }, // trailing comma
]`;
    const parsed = parseKeybindings(text);
    assert.strictEqual(parsed.length, 1);
    assert.strictEqual(parsed[0].command, "foo");
  });

  test("userBinding returns the last positive override", () => {
    const entries: KeybindingEntry[] = [
      { key: "cmd+a", command: "workbench.action.terminal.focus" },
      { key: "cmd+b", command: "workbench.action.terminal.focus" },
      { key: "cmd+c", command: "other" },
    ];
    assert.strictEqual(userBinding(entries, "workbench.action.terminal.focus")?.key, "cmd+b");
    assert.strictEqual(userBinding(entries, "missing"), undefined);
  });

  test("effectiveBinding: user override wins; falls back to known default; else undefined", () => {
    // No override, no known default -> undefined.
    assert.strictEqual(effectiveBinding([], focusTerminal, "mac"), undefined);

    // No override, known default -> default.
    const def = effectiveBinding([], togglePanel, "mac");
    assert.deepStrictEqual(def, { key: "cmd+j", source: "default" });

    // Override present -> user.
    const overridden = effectiveBinding(
      [{ key: "cmd+x", command: "workbench.action.togglePanel" }],
      togglePanel,
      "mac",
    );
    assert.deepStrictEqual(overridden, { key: "cmd+x", source: "user" });
  });

  test("isApplied compares the recommended key (whitespace/case-insensitive)", () => {
    assert.strictEqual(isApplied([], focusTerminal, "mac"), false);
    const entries: KeybindingEntry[] = [
      { key: "CMD + '", command: "workbench.action.terminal.focus" },
    ];
    assert.strictEqual(isApplied(entries, focusTerminal, "mac"), true);
    // Default already matches recommended for togglePanel on mac.
    assert.strictEqual(isApplied([], togglePanel, "mac"), true);
  });

  test("isApplied treats modifier order as equivalent (VS Code canonicalizes order)", () => {
    // VS Code stores `cmd+shift+=` as `shift+cmd+=`; that's the same binding.
    assert.strictEqual(
      isApplied(
        [{ key: "shift+cmd+=", command: "workbench.action.toggleMaximizedPanel" }],
        fullscreenTerminal,
        "mac",
      ),
      true,
    );
    // Same for the terminal tab shortcuts the user reported as "set but shown as not set".
    assert.strictEqual(
      isApplied(
        [
          {
            key: "shift+cmd+[",
            command: "workbench.action.terminal.focusPrevious",
            when: "terminalFocus",
          },
        ],
        terminalTabPrev,
        "mac",
      ),
      true,
    );
  });

  test("terminal-tab shortcuts recognize the VS Code mac default (no user override needed)", () => {
    // `cmd+shift+[` / `cmd+shift+]` are the VS Code mac DEFAULTS for terminal focusPrevious/focusNext.
    // They're not in keybindings.json (which only holds overrides), so a known-defaults table must let
    // us recognize them as already applied instead of prompting.
    const prev = MANAGED_SHORTCUTS.find((s) => s.id === "terminal-tab-prev")!;
    const next = MANAGED_SHORTCUTS.find((s) => s.id === "terminal-tab-next")!;
    assert.strictEqual(isApplied([], prev, "mac"), true);
    assert.strictEqual(isApplied([], next, "mac"), true);
    assert.deepStrictEqual(effectiveBinding([], prev, "mac"), {
      key: "cmd+shift+[",
      source: "default",
    });
  });

  test("applyShortcut writes the binding plus its default removals; isApplied needs both", () => {
    const quickLaunch = MANAGED_SHORTCUTS.find((s) => s.id === "quick-launch")!;
    assert.ok(quickLaunch.removeDefaults?.length, "quick-launch has a removal");
    assert.strictEqual(quickLaunch.command, "workbench.action.terminal.newWithProfile");

    assert.strictEqual(isApplied([], quickLaunch, "mac"), false);

    const parsed = parseKeybindings(applyShortcut("[]", quickLaunch, "mac"));
    assert.ok(
      parsed.some((e) => e.command === "workbench.action.terminal.newWithProfile" && e.key),
      "positive binding written",
    );
    assert.ok(
      parsed.some((e) => e.command === "-workbench.action.terminal.new" && e.key),
      "default terminal.new removed off the key",
    );
    assert.strictEqual(isApplied(parsed, quickLaunch, "mac"), true);

    // Positive present but the removal missing → still "not set" so Set re-applies the removal.
    const positiveOnly = parseKeybindings(
      upsertBinding("[]", {
        command: "workbench.action.terminal.newWithProfile",
        key: "ctrl+shift+`",
      }),
    );
    assert.strictEqual(isApplied(positiveOnly, quickLaunch, "mac"), false);
  });

  test("recommendedKey switches on platform", () => {
    assert.strictEqual(recommendedKey(focusTerminal, "mac"), "cmd+'");
    assert.strictEqual(recommendedKey(focusTerminal, "other"), "ctrl+'");
  });

  test("upsertBinding appends to empty/new file", () => {
    const out = upsertBinding("", {
      command: "workbench.action.terminal.focus",
      key: "cmd+'",
    });
    const parsed = parseKeybindings(out);
    assert.strictEqual(parsed.length, 1);
    assert.strictEqual(parsed[0].command, "workbench.action.terminal.focus");
    assert.strictEqual(parsed[0].key, "cmd+'");
  });

  test("upsertBinding updates an existing entry in place, keeping others", () => {
    const text = `[
  { "key": "cmd+a", "command": "workbench.action.terminal.focus" },
  { "key": "cmd+z", "command": "keep.me" }
]`;
    const out = upsertBinding(text, {
      command: "workbench.action.terminal.focus",
      key: "cmd+'",
      when: "terminalFocus",
    });
    const parsed = parseKeybindings(out);
    assert.strictEqual(parsed.length, 2, "no duplicate entry added");
    const focus = parsed.find((e) => e.command === "workbench.action.terminal.focus");
    assert.strictEqual(focus?.key, "cmd+'");
    assert.strictEqual(focus?.when, "terminalFocus");
    assert.ok(
      parsed.some((e) => e.command === "keep.me" && e.key === "cmd+z"),
      "other bindings preserved",
    );
  });

  test("upsertBinding preserves comments in the file", () => {
    const text = `// keep this comment
[
  { "key": "cmd+z", "command": "keep.me" }
]`;
    const out = upsertBinding(text, {
      command: "workbench.action.togglePanel",
      key: "cmd+j",
    });
    assert.ok(out.includes("// keep this comment"), "leading comment survives");
    const parsed = parseKeybindings(out);
    assert.strictEqual(parsed.length, 2);
  });
});

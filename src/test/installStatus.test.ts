// The sidebar setup prompt: which agent install states raise an "install" or "update" nudge, and
// the tree row that carries the user to the Welcome screen.

import * as assert from "node:assert";

import * as vscode from "vscode";

import { Commands } from "../config.js";
import { type AgentInstallRow, setupPrompt } from "../welcome/installStatus.js";
import { setupNoticeItem } from "../views/MainTreeProvider.js";

function row(
  id: string,
  installState: AgentInstallRow["installState"],
  available = true,
): AgentInstallRow {
  return { id, name: `${id} agent`, available, installState };
}

suite("agent setup prompt", () => {
  test("no prompt when every available agent is installed", () => {
    const rows = [
      row("claude-code", "installed"),
      row("codex", "installed"),
      row("opencode", "installed"),
    ];
    assert.strictEqual(setupPrompt(rows), undefined);
  });

  test("install prompt when no available agent is installed", () => {
    const rows = [
      row("claude-code", "not-installed"),
      row("codex", "not-installed"),
      row("opencode", "not-installed"),
      row("pi", "not-installed", false),
    ];
    assert.deepStrictEqual(setupPrompt(rows), { kind: "install" });
  });

  test("update prompt names only the stale agents", () => {
    const rows: AgentInstallRow[] = [
      { id: "claude-code", name: "Claude Code", available: true, installState: "installed" },
      { id: "codex", name: "Codex TUI", available: true, installState: "update-available" },
      { id: "opencode", name: "OpenCode TUI", available: true, installState: "not-installed" },
    ];
    assert.deepStrictEqual(setupPrompt(rows), { kind: "update", agentNames: ["Codex TUI"] });
  });

  test("no prompt when one agent is installed and the rest are unused", () => {
    const rows = [
      row("claude-code", "installed"),
      row("codex", "not-installed"),
      row("opencode", "not-installed"),
    ];
    assert.strictEqual(setupPrompt(rows), undefined);
  });

  test("unavailable agents never raise a prompt", () => {
    assert.strictEqual(setupPrompt([row("pi", "not-installed", false)]), undefined);
  });
});

suite("setup notice row", () => {
  test("install notice opens the Welcome screen", () => {
    const item = setupNoticeItem({ kind: "install" });
    assert.strictEqual(item.command?.command, Commands.openWelcome);
    assert.strictEqual(item.collapsibleState, vscode.TreeItemCollapsibleState.None);
    assert.strictEqual(item.contextValue, "setupNotice");
  });

  test("update notice lists the stale agents", () => {
    const item = setupNoticeItem({
      kind: "update",
      agentNames: ["Codex TUI", "OpenCode TUI"],
    });
    assert.strictEqual(item.description, "Codex TUI, OpenCode TUI");
    assert.strictEqual(item.command?.command, Commands.openWelcome);
  });
});

// The extension host's probe cache. The Codex probe asks its CLI, so the cost that matters here is
// how many times the agents are asked: activation schedules a probe and the Welcome screen asks for
// one the moment it opens, and those two must share a single pass.

import * as assert from "node:assert";

import * as vscode from "vscode";

import type { InstallContext } from "../welcome/agents.js";
import { AgentInstallStatus } from "../welcome/AgentInstallStatus.js";
import type { AgentInstallRow } from "../welcome/installStatus.js";

/** The class reads two paths off the context and nothing else. */
const context = {
  extensionUri: vscode.Uri.file("/fake/extension"),
  globalStorageUri: vscode.Uri.file("/fake/storage"),
} as unknown as vscode.ExtensionContext;

function row(id: string, installState: AgentInstallRow["installState"]): AgentInstallRow {
  return { id, name: `${id} agent`, available: true, installState };
}

/** A probe pass that counts its calls and answers with whatever the test queued. */
function countingProbe(answers: AgentInstallRow[][]) {
  const state = { calls: 0 };
  const probe = (
    _installContextFor: (agentId: string) => InstallContext,
  ): Promise<AgentInstallRow[]> => {
    const answer = answers[Math.min(state.calls, answers.length - 1)];
    state.calls += 1;
    return Promise.resolve(answer);
  };
  return { state, probe };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

suite("agent install status cache", () => {
  test("a scheduled probe does not run again when a refresh gets there first", async () => {
    const { state, probe } = countingProbe([[row("codex", "installed")]]);
    const status = new AgentInstallStatus(context, probe);
    try {
      status.scheduleRefresh();
      await status.refresh();
      await tick();
      assert.strictEqual(state.calls, 1, "the agents must be asked once");
    } finally {
      status.dispose();
    }
  });

  test("a refresh during a probe joins the one already running", async () => {
    const { state, probe } = countingProbe([[row("codex", "installed")]]);
    const status = new AgentInstallStatus(context, probe);
    try {
      const first = status.refresh();
      const second = status.refresh();
      assert.strictEqual(first, second, "both callers must wait on the same probe");
      await first;
      assert.strictEqual(state.calls, 1);
    } finally {
      status.dispose();
    }
  });

  test("a later refresh probes again", async () => {
    const { state, probe } = countingProbe([[row("codex", "installed")]]);
    const status = new AgentInstallStatus(context, probe);
    try {
      await status.refresh();
      await status.refresh();
      assert.strictEqual(state.calls, 2);
    } finally {
      status.dispose();
    }
  });

  test("onDidChange fires for a row that moved, and stays quiet when nothing did", async () => {
    const { probe } = countingProbe([
      [row("codex", "not-installed")],
      [row("codex", "installed")],
      [row("codex", "installed")],
    ]);
    const status = new AgentInstallStatus(context, probe);
    let fired = 0;
    const sub = status.onDidChange(() => {
      fired += 1;
    });
    try {
      await status.refresh();
      assert.strictEqual(fired, 1, "the first result is a change from nothing");
      await status.refresh();
      assert.strictEqual(fired, 2, "not-installed became installed");
      await status.refresh();
      assert.strictEqual(fired, 2, "an unchanged result must not fire");
    } finally {
      sub.dispose();
      status.dispose();
    }
  });

  test("the cache is empty until the first probe lands", async () => {
    const { probe } = countingProbe([[row("codex", "not-installed")]]);
    const status = new AgentInstallStatus(context, probe);
    try {
      assert.deepStrictEqual(status.snapshot(), []);
      assert.strictEqual(status.prompt(), undefined, "no nudge may flash during activation");
      await status.refresh();
      assert.deepStrictEqual(status.prompt(), { kind: "install" });
    } finally {
      status.dispose();
    }
  });

  test("the install context points at the shipped plugins and the agent's own dir", () => {
    const status = new AgentInstallStatus(context);
    try {
      const ctx = status.installContext("codex");
      assert.ok(ctx.pluginsRoot.endsWith("/dist/plugins"), ctx.pluginsRoot);
      assert.ok(ctx.stableDir.endsWith("/adapters/codex"), ctx.stableDir);
    } finally {
      status.dispose();
    }
  });
});

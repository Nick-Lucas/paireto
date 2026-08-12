// Integration test (VS Code Extension Host) for the plan gate's early-close path when file comments
// are queued. Closing the plan tab asks for an outcome; choosing Send Feedback then asks whether to
// carry the file comments. Cancelling that second modal answers nothing, so the plan document must
// come back — the tab is already gone and there is no other way to reach a foreground plan.

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as net from "node:net";

import * as vscode from "vscode";

import { Commands, Schemes } from "../config.js";
import type { InspectSnapshot } from "../e2e/inspectTypes.js";
import { canonicalize, repoKey, socketPath } from "../protocol/paths.js";
import { PLUGIN_VERSION } from "../protocol/types.js";

const PLAN_MARKDOWN = "# Plan\n\n- Step one\n- Step two\n";
const PLAN_REQUEST_ID = "plan-early-close-1";

interface Wire {
  send(msg: Record<string, unknown>): void;
  messages: Record<string, unknown>[];
  close(): void;
}

async function connectBridge(sockPath: string): Promise<Wire> {
  const messages: Record<string, unknown>[] = [];
  const socket = net.createConnection(sockPath);
  socket.setEncoding("utf8");
  socket.on("error", () => {});
  let buffer = "";
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.trim() !== "") {
        messages.push(JSON.parse(line) as Record<string, unknown>);
      }
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return {
    send: (msg) => socket.write(`${JSON.stringify(msg)}\n`),
    messages,
    close: () => socket.destroy(),
  };
}

async function waitFor<T>(
  what: string,
  probe: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function planTab(): vscode.Tab | undefined {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputText && tab.input.uri.scheme === Schemes.plan) {
        return tab;
      }
    }
  }
  return undefined;
}

function inspect(): Thenable<InspectSnapshot> {
  return vscode.commands.executeCommand<InspectSnapshot>("paireto.test.inspect");
}

suite("plan early close with queued file comments", () => {
  test("cancelling the file-comment prompt brings the plan document back", async function () {
    this.timeout(90_000);
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, "the test harness must open the fixture git workspace");
    await vscode.extensions.getExtension("Paireto.paireto")?.activate();
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");

    const repoRoot = canonicalize(folder.uri.fsPath);
    const sockPath = socketPath(repoRoot);
    assert.ok(fs.existsSync(sockPath), `the extension must bind a bridge socket at ${sockPath}`);

    // Answer the modals the plan gate raises. Matched on the message so an unrelated warning cannot
    // consume an answer.
    const seen: string[] = [];
    const codeAnswers: (string | undefined)[] = [undefined, "Include File Comments"];
    const realWarning = vscode.window.showWarningMessage;
    const stub = (message: string): Thenable<string | undefined> => {
      seen.push(message);
      if (message.includes("still waiting on this plan")) {
        return Promise.resolve("Send Feedback");
      }
      if (message.includes("file comment")) {
        return Promise.resolve(codeAnswers.shift());
      }
      return Promise.resolve(undefined);
    };
    (vscode.window as unknown as Record<string, unknown>).showWarningMessage = stub;

    const wire = await connectBridge(sockPath);
    try {
      wire.send({
        t: "hello",
        v: PLUGIN_VERSION,
        ts: new Date().toISOString(),
        role: "hook",
        pluginVersion: PLUGIN_VERSION,
        repoKey: repoKey(repoRoot),
      });
      await waitFor("the bridge handshake", () =>
        wire.messages.find((m) => m.t === "hello.ack" && m.accept === true),
      );

      // A file comment queued outside any review session: this is what makes the gate ask.
      const queued = await vscode.commands.executeCommand<boolean>("paireto.test.addComment", {
        surface: "review",
        kind: "comment",
        path: "notes.txt",
        line: 0,
        text: "Rename this file.",
      });
      assert.strictEqual(queued, true, "the file comment must attach to the fixture repo");
      await waitFor("the file comment to register", async () =>
        (await inspect()).commentBucketCount > 0 ? true : undefined,
      );

      wire.send({
        t: "plan.review.request",
        v: PLUGIN_VERSION,
        id: PLAN_REQUEST_ID,
        ts: new Date().toISOString(),
        harness: "claudecode",
        repoRoot,
        event: {
          session_id: "early-close-session",
          transcript_path: "t",
          cwd: repoRoot,
          hook_event_name: "PreToolUse",
          tool_name: "ExitPlanMode",
          tool_input: { plan: PLAN_MARKDOWN },
        },
      });
      const tab = await waitFor("the plan tab to open", () => planTab());

      const commented = await vscode.commands.executeCommand<boolean>("paireto.test.addComment", {
        surface: "plan",
        kind: "problem",
        line: 2,
        text: "Split step two.",
      });
      assert.strictEqual(commented, true, "the plan comment must attach to the plan document");
      await waitFor("the plan comment to register", async () =>
        (await inspect()).gateHasFeedback ? true : undefined,
      );

      await vscode.window.tabGroups.close(tab);
      await waitFor("the file-comment prompt", () =>
        seen.some((m) => m.includes("file comment")) ? true : undefined,
      );

      const reopened = await waitFor("the plan document to come back", () => planTab());
      assert.ok(reopened, "cancelling the prompt must reopen the plan");
      assert.strictEqual(
        wire.messages.some((m) => m.t === "plan.review.response"),
        false,
        "a cancelled prompt must leave the plan gate pending",
      );

      // The gate is still usable: sending again, this time including the file comments, resolves it.
      await vscode.commands.executeCommand(Commands.gateSendFeedback);
      const response = await waitFor("the plan gate response", () =>
        wire.messages.find((m) => m.t === "plan.review.response"),
      );
      assert.strictEqual(response.decision, "deny");
      const reason = String(response.reason);
      assert.ok(reason.includes("Split step two."), "the plan feedback rides in the response");
      assert.ok(reason.includes("notes.txt"), "the file comment rides in the response");
      await waitFor("the file comments to clear", async () =>
        (await inspect()).commentBucketCount === 0 ? true : undefined,
      );
    } finally {
      (vscode.window as unknown as Record<string, unknown>).showWarningMessage = realWarning;
      wire.close();
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    }
  });
});

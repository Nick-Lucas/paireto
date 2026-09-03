// Shared driving code for the extension-host tests that exercise the plan gate over the real bridge
// socket. Everything here goes through the product: a hook-role connection carries the requests, the
// env-gated control plane attaches comments through the real add-comment commands, and the tests
// answer modals by stubbing the window API. Not a *.test.ts file, so mocha does not load it as a
// suite.

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as net from "node:net";

import * as vscode from "vscode";

import { Schemes } from "../config.js";
import type { AddCommentArgs, InspectSnapshot } from "../e2e/inspectTypes.js";
import { canonicalize, repoKey, socketPath } from "../protocol/paths.js";
import type { Harness } from "../protocol/types.js";
import { PLUGIN_VERSION } from "../protocol/types.js";

export const PLAN_MARKDOWN = "# Plan\n\n- Step one\n- Step two\n";
/** The one file the fixture workspace commits (see .vscode-test.mjs). */
export const FIXTURE_FILE = "notes.txt";

export interface Wire {
  send(msg: Record<string, unknown>): void;
  messages: Record<string, unknown>[];
  close(): void;
}

export interface WarningStub {
  /** Every warning message raised while the stub is installed, in order. */
  seen: string[];
  restore(): void;
}

export async function waitFor<T>(
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

export function planTab(): vscode.Tab | undefined {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputText && tab.input.uri.scheme === Schemes.plan) {
        return tab;
      }
    }
  }
  return undefined;
}

export function inspect(): Thenable<InspectSnapshot> {
  return vscode.commands.executeCommand<InspectSnapshot>("paireto.test.inspect");
}

/** Activate the extension over the fixture git workspace; returns its canonical root. */
export async function activateForFixtureRepo(): Promise<string> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, "the test harness must open the fixture git workspace");
  await vscode.extensions.getExtension("Paireto.paireto")?.activate();
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  return canonicalize(folder.uri.fsPath);
}

/** A handshaken hook connection to this repository's bridge socket. */
export async function openWire(repoRoot: string): Promise<Wire> {
  const sockPath = socketPath(repoRoot);
  assert.ok(fs.existsSync(sockPath), `the extension must bind a bridge socket at ${sockPath}`);
  const wire = await connectBridge(sockPath);
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
  return wire;
}

/** Send a plan for review and wait for its tab. */
export async function openPlan(
  wire: Wire,
  opts: { repoRoot: string; id: string; sessionId: string; markdown?: string; harness?: Harness },
): Promise<vscode.Tab> {
  sendPlanRequest(wire, opts);
  return waitFor("the plan tab to open", () => planTab());
}

/** The request alone, so a test can act while the gate is still opening its UI. */
export function sendPlanRequest(
  wire: Wire,
  opts: {
    repoRoot: string;
    id: string;
    sessionId: string;
    markdown?: string;
    harness?: Harness;
  },
): void {
  wire.send({
    t: "plan.review.hook.request",
    v: PLUGIN_VERSION,
    id: opts.id,
    ts: new Date().toISOString(),
    harness: opts.harness ?? "claudecode",
    repoRoot: opts.repoRoot,
    event: {
      session_id: opts.sessionId,
      transcript_path: "t",
      cwd: opts.repoRoot,
      hook_event_name: "PreToolUse",
      tool_name: "ExitPlanMode",
      tool_input: { plan: opts.markdown ?? PLAN_MARKDOWN },
    },
  });
}

/** Start a code review and wait for its gate to take the foreground. */
export async function startReview(
  wire: Wire,
  opts: { repoRoot: string; id: string; sessionId?: string },
): Promise<void> {
  sendReviewRequest(wire, opts);
  await waitForForegroundGate("review");
}

/** The request alone, so a test can act while the review is still opening its UI. */
export function sendReviewRequest(
  wire: Wire,
  opts: { repoRoot: string; id: string; sessionId?: string },
): void {
  wire.send({
    t: "review.await.request",
    v: PLUGIN_VERSION,
    id: opts.id,
    ts: new Date().toISOString(),
    cwd: opts.repoRoot,
    repoRoot: opts.repoRoot,
    harness: "claudecode",
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
  });
}

/** Wait until a gate of this kind holds the foreground — the point from which the shared Approve /
 *  Send Feedback commands dispatch to it. */
export async function waitForForegroundGate(kind: "plan" | "review" | "guided"): Promise<void> {
  await waitFor(`the ${kind} gate to come forward`, async () =>
    (await inspect()).gates.some((g) => g.kind === kind && g.foreground) ? true : undefined,
  );
}

/** Comment on a repository file. Outside a review session this is what queues the bucket. */
/** Comment on a repository file and report the id the extension minted for it. The bucket is shared
 *  with whatever other suites left in it, so a caller identifies its own item by that id. */
export async function queueFileComment(
  text: string,
  opts: { path?: string; line?: number; kind?: AddCommentArgs["kind"] } = {},
): Promise<string> {
  const before = new Set((await inspect()).feedback.map((item) => item.id));
  const args: AddCommentArgs = {
    surface: "review",
    kind: opts.kind ?? "comment",
    path: opts.path ?? FIXTURE_FILE,
    line: opts.line ?? 0,
    text,
  };
  const queued = await vscode.commands.executeCommand<boolean>("paireto.test.addComment", args);
  assert.strictEqual(queued, true, "the file comment must attach to the fixture repo");
  return waitFor("the file comment to register", async () =>
    (await inspect()).feedback.map((item) => item.id).find((id) => !before.has(id)),
  );
}

/** Comment on the open plan document. */
export async function addPlanComment(
  text: string,
  opts: { line?: number; kind?: AddCommentArgs["kind"]; reply?: boolean } = {},
): Promise<void> {
  const args: AddCommentArgs = {
    surface: "plan",
    kind: opts.kind ?? "comment",
    line: opts.line ?? 2,
    reply: opts.reply,
    text,
  };
  const commented = await vscode.commands.executeCommand<boolean>("paireto.test.addComment", args);
  assert.strictEqual(commented, true, "the plan comment must attach to the plan document");
  await waitFor("the plan comment to register", async () =>
    (await inspect()).gateHasFeedback ? true : undefined,
  );
}

/** Answer the modals a flow raises. `reply` receives the message, so an unrelated warning cannot
 *  consume an answer meant for another prompt. */
export function stubWarnings(reply: (message: string) => string | undefined): WarningStub {
  const seen: string[] = [];
  const real = vscode.window.showWarningMessage;
  const stub = (message: string): Thenable<string | undefined> => {
    seen.push(message);
    return Promise.resolve(reply(message));
  };
  (vscode.window as unknown as Record<string, unknown>).showWarningMessage = stub;
  return {
    seen,
    restore: () => {
      (vscode.window as unknown as Record<string, unknown>).showWarningMessage = real;
    },
  };
}

/** Editors and gates from one test must not reach the next one. Closing the wire aborts whatever it
 *  left in flight, which is how the controllers drop their UI. */
export async function resetWorkbench(wire: Wire): Promise<void> {
  wire.close();
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  await waitFor("the plan tabs to close", () => (planTab() === undefined ? true : undefined));
  await waitFor("the gates to clear", async () =>
    (await inspect()).gates.length === 0 ? true : undefined,
  );
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

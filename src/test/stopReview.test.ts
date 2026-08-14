import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import * as vscode from "vscode";

import {
  activateForFixtureRepo,
  clearFeedback,
  inspect,
  waitFor,
  waitForForegroundGate,
} from "./planGateHarness.js";

suite("Stop review over the bridge", function () {
  this.timeout(30_000);
  for (const harness of ["claudecode", "codex"] as const) {
    test(`${harness}: shell edits block Stop, feedback returns a refusal, approval allows Stop`, async () => {
      const repoRoot = await activateForFixtureRepo();
      const children: ChildProcess[] = [];
      const responses: { id: string; decision: string; reason?: string }[] = [];
      const sessionId = `stop-shell-${harness}`;
      const file = path.join(repoRoot, `${sessionId}.txt`);
      const send = async (hook: string, id?: string, toolName = "Bash") => {
        const message = {
          event: {
            hook_event_name: hook,
            session_id: sessionId,
            cwd: repoRoot,
            transcript_path: "",
            tool_name: toolName,
            tool_input: { command: "echo changed > file" },
          },
        };
        const script =
          harness === "claudecode"
            ? `claude-code/scripts/${id ? "on-review-gate" : "on-event"}.js`
            : `agent-plugin/com.openai.codex/runtime/${id ? "on-stop-gate" : "on-event"}.js`;
        const completion = new Promise<void>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [path.resolve(__dirname, "../../dist/plugins", script)],
            {
              env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
              stdio: ["pipe", "pipe", "pipe"],
            },
          );
          children.push(child);
          let output = "";
          child.stdout.on("data", (chunk) => {
            output += String(chunk);
          });
          child.stderr.on("data", () => {});
          child.on("error", reject);
          child.on("close", (code) => {
            if (code !== 0) {
              reject(new Error(`hook exited ${code}`));
              return;
            }
            try {
              // A hook that prints anything but its JSON response must fail this test, not throw
              // uncaught out of the close callback and take the whole run down with it.
              if (id) {
                responses.push({
                  id,
                  ...(output.trim() ? JSON.parse(output) : { decision: "allow" }),
                });
              }
            } catch (error) {
              reject(
                new Error(`hook wrote unparseable output ${JSON.stringify(output)}: ${error}`),
              );
              return;
            }
            resolve();
          });
          child.stdin.end(JSON.stringify(message.event));
        });
        if (id) {
          void completion.catch((error) =>
            responses.push({ id, decision: "error", reason: String(error) }),
          );
        } else {
          await completion;
        }
      };
      // A turn is only comparable once its Git snapshot is in place — an edit written while the
      // snapshot is still being taken lands IN it, and the Stop then reports nothing to review.
      const startTurn = async () => {
        await send("UserPromptSubmit");
        await waitFor("the turn to start", async () =>
          (await inspect()).sessions.find(
            (s) => s.sessionId === sessionId && s.state === "thinking",
          ),
        );
        await waitFor("the turn-start snapshot", async () =>
          (await inspect()).turnBaselinePending ? undefined : true,
        );
      };
      try {
        await startTurn();
        await send("PreToolUse");
        await waitFor("the shell tool to start", async () =>
          (await inspect()).sessions.find(
            (s) => s.sessionId === sessionId && s.state === "toolRunning",
          ),
        );
        await fs.writeFile(file, "first\n");
        await send("PostToolUse");
        await send("Stop");
        await send("Stop", "first-stop");
        await waitFor(
          "the automatic review or Stop response",
          async () =>
            responses.find((m) => m.id === "first-stop") ??
            (await inspect()).gates.find((g) => g.kind === "review" && g.sessionId === sessionId),
        );
        assert.ok(!responses.some((m) => m.id === "first-stop"), "Stop must wait for the reviewer");
        await waitForForegroundGate("review");
        await waitFor("the feedback comment", async () => {
          if ((await inspect()).gateHasFeedback) {
            return true;
          }
          await vscode.commands.executeCommand("paireto.test.addComment", {
            surface: "review",
            path: path.basename(file),
            kind: "comment",
            text: "Change first to second.",
          });
          return undefined;
        });
        await vscode.commands.executeCommand("paireto.gate.sendFeedback");
        const refused = await waitFor("the refusal", () =>
          responses.find((m) => m.id === "first-stop"),
        );
        assert.strictEqual(refused.decision, "block");
        assert.match(String(refused.reason), /Change first to second/);

        await send("PreToolUse");
        await waitFor("the next shell tool", async () =>
          (await inspect()).sessions.find(
            (s) => s.sessionId === sessionId && s.state === "toolRunning",
          ),
        );
        await send("Stop", "second-stop");
        const unchangedAfterFeedback = await waitFor("Stop without edits after feedback", () =>
          responses.find((m) => m.id === "second-stop"),
        );
        assert.strictEqual(unchangedAfterFeedback.decision, "allow");

        await startTurn();
        await send("PreToolUse");
        await fs.writeFile(file, "second\n");
        await send("Stop", "stop-without-post");
        await waitForForegroundGate("review");
        assert.ok(!responses.some((m) => m.id === "stop-without-post"));
        await vscode.commands.executeCommand("paireto.gate.approve");
        assert.strictEqual(
          (
            await waitFor("approval without PostToolUse", () =>
              responses.find((m) => m.id === "stop-without-post"),
            )
          ).decision,
          "allow",
        );

        await startTurn();
        await send("PreToolUse");
        await send("PostToolUse", undefined, harness === "codex" ? "apply_patch" : "Write");
        await send("Stop", "read-only-stop");
        const unchanged = await waitFor("the unchanged turn", () =>
          responses.find((m) => m.id === "read-only-stop"),
        );
        assert.strictEqual(
          unchanged.decision,
          "allow",
          "existing changes must not trigger another review",
        );
      } finally {
        for (const child of children) {
          if (child.exitCode === null) {
            child.kill();
          }
        }
        await fs.rm(file, { force: true });
        // Release a review the test left open (an assertion failed mid-review) BEFORE waiting for
        // the gates to clear, or that wait times out and reports itself instead of the real failure.
        for (let attempt = 0; attempt < 3 && (await inspect()).gates.length > 0; attempt++) {
          await vscode.commands.executeCommand("paireto.gate.approve");
        }
        await waitFor("review cleanup", async () =>
          (await inspect()).gates.length === 0 ? true : undefined,
        );
        await clearFeedback();
      }
    });
  }
});

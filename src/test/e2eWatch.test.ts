// The live-watch surface for an E2E run: what reaches the run's stdout, and the command that shows
// the TUI in real time.

import * as assert from "node:assert";

import { openCodeRunArgs, openCodeRunFatal } from "../e2e/drivers/opencode.js";
import { keepRpcLine, piPromptLine, piRpcFatal } from "../e2e/drivers/pi.js";
import {
  attachCommand,
  createPaneWatch,
  newPaneLines,
  watchEnabled,
  WATCH_ENV,
} from "../e2e/drivers/watch.js";

suite("E2E watch toggle", () => {
  test("streams by default", () => {
    assert.strictEqual(watchEnabled({}), true);
    assert.strictEqual(watchEnabled({ [WATCH_ENV]: "1" }), true);
  });

  test("silences for an unattended run", () => {
    for (const value of ["0", "off", "false", "OFF"]) {
      assert.strictEqual(watchEnabled({ [WATCH_ENV]: value }), false, value);
    }
  });
});

suite("E2E watch pane stream", () => {
  test("emits appended output once", () => {
    const first = ["> plan the change", ""];
    assert.deepStrictEqual(newPaneLines([], first), ["> plan the change"]);
    assert.deepStrictEqual(newPaneLines(first, [...first, "writing plan..."]), ["writing plan..."]);
  });

  test("emits nothing while the screen is unchanged", () => {
    const pane = ["> plan the change", "writing plan..."];
    assert.deepStrictEqual(newPaneLines(pane, pane), []);
  });

  test("re-emits a repainted region, which is how a TUI shows progress", () => {
    const before = ["header", "esc to interrupt (3s)"];
    const after = ["header", "esc to interrupt (4s)"];
    assert.deepStrictEqual(newPaneLines(before, after), ["esc to interrupt (4s)"]);
  });

  test("drops blank padding so an idle pane stays quiet", () => {
    assert.deepStrictEqual(newPaneLines([], ["", "  ", "real output", "", ""]), ["real output"]);
  });
});

suite("E2E watch attach command", () => {
  test("attaches read-only, so a stray keystroke cannot reach the agent's prompt", () => {
    const native = attachCommand("pai-e2e-123-abc", "main", false);
    assert.strictEqual(native, "tmux -L pai-e2e-123-abc attach -t main -r");
  });

  test("goes through the container when the run is in Docker", () => {
    const docker = attachCommand("pai-e2e-123-abc", "main", true);
    assert.match(
      docker,
      /^docker compose .* exec tests tmux -L pai-e2e-123-abc attach -t main -r$/,
    );
  });
});

// The plan agent's permission rules deny every edit until a plan approval releases it. A case that
// never proposes a plan (the guided review) must therefore not run under it — its agent could group
// the changes but could never act on the feedback the reviewer sent back.
suite("OpenCode run agent", () => {
  const turn = { serverUrl: "http://127.0.0.1:4096", repoRoot: "/tmp/repo", prompt: "go" };

  test("a case that proposes a plan runs under the plan agent", () => {
    const args = openCodeRunArgs({ ...turn, planMode: true });
    assert.ok(args.includes("--agent"));
    assert.strictEqual(args[args.indexOf("--agent") + 1], "plan");
  });

  test("a case that never proposes a plan runs under the default agent", () => {
    const args = openCodeRunArgs({ ...turn, planMode: false });
    assert.ok(!args.includes("--agent"), "the plan agent could not act on review feedback");
    assert.strictEqual(args.at(-1), "go", "the prompt stays last");
    assert.ok(args.includes("--model"));
  });
});

suite("Pi RPC session", () => {
  test("plan mode rides on the package's own command", () => {
    assert.strictEqual(piPromptLine("add hello.txt", true), "/paireto-plan add hello.txt");
  });

  test("ordinary work is sent as the user typed it", () => {
    assert.strictEqual(piPromptLine("/skill:paireto-review go", false), "/skill:paireto-review go");
  });

  test("token-delta events are kept out of the failure log, which the reporter would drop", () => {
    assert.strictEqual(keepRpcLine(JSON.stringify({ type: "message_update" })), false);
    assert.strictEqual(keepRpcLine(JSON.stringify({ type: "tool_execution_end" })), true);
    assert.strictEqual(keepRpcLine("not json at all"), true);
  });
});

suite("E2E fail-fast signals", () => {
  test("an auto-rejected permission ends the run, naming the request", () => {
    const fatal = openCodeRunFatal(
      "! permission requested: external_directory (/tmp/paireto-e2e-opencode/*); auto-rejecting",
    );

    assert.ok(fatal);
    assert.match(fatal, /external_directory/);
    assert.match(fatal, /outside the sandbox it was given/);
  });

  test("a rejected tool call ends the run", () => {
    assert.ok(
      openCodeRunFatal("Error: The user rejected permission to use this specific tool call."),
    );
  });

  test("a rejected Pi RPC command ends the run, quoting what Pi said", () => {
    const fatal = piRpcFatal(
      JSON.stringify({ type: "response", command: "prompt", success: false, error: "busy" }),
    );

    assert.ok(fatal);
    assert.match(fatal, /busy/);
  });

  test("an accepted Pi RPC command and a plain event are not fatal", () => {
    for (const line of [
      JSON.stringify({ id: "pai-1", type: "response", command: "prompt", success: true }),
      JSON.stringify({ type: "agent_settled" }),
      "not json at all",
    ]) {
      assert.strictEqual(piRpcFatal(line), undefined, line);
    }
  });

  test("ordinary progress is not fatal", () => {
    for (const line of [
      '⚙ paireto_submit_plan {"plan":"1. Create hello.txt"}',
      "> plan · gpt-5.6-luna",
      "",
    ]) {
      assert.strictEqual(openCodeRunFatal(line), undefined, line);
    }
  });

  test("a TUI that exits mid-flow is reported once, not per poll", () => {
    const reasons: string[] = [];
    let exited: number | undefined;
    const watch = createPaneWatch(
      "claudecode",
      {
        captureHistory: () => "screen",
        attachTarget: () => ({ label: "pai-e2e-x", session: "main" }),
        exitStatus: () => exited,
      },
      (reason) => reasons.push(reason),
    );
    assert.ok(watch);

    watch.poll();
    assert.deepStrictEqual(reasons, [], "a live pane reports nothing");

    // The pane keeps reporting the same exit status while the keepalive holds it open.
    exited = 1;
    watch.poll();
    watch.poll();
    watch.poll();

    assert.strictEqual(reasons.length, 1);
    assert.match(reasons[0], /claudecode TUI exited \(status 1\)/);
    watch.stop();
  });

  test("a live pane with nothing to report still streams, but never reports fatal", () => {
    const reasons: string[] = [];
    const watch = createPaneWatch(
      "codex",
      {
        captureHistory: () => "still working",
        attachTarget: () => ({ label: "pai-e2e-y", session: "main" }),
        exitStatus: () => undefined,
      },
      (reason) => reasons.push(reason),
    );
    assert.ok(watch);

    watch.poll();
    watch.poll();

    assert.deepStrictEqual(reasons, []);
    watch.stop();
  });
});

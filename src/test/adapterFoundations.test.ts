// Stage-1 shared-foundations coverage for the Codex/OpenCode adapter seam: the liveness-less
// sweep-removal fallback, the per-agent onboarding install stamp + probe, and a demonstration of the
// shared mapper-fixture helper against the Claude strategy (the harness-specific fixture suites land
// with their strategies in later stages).

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  AgentSessionService,
  LIVENESS_LESS_REMOVE_MS_FOR_TEST,
} from "../agents/AgentSessionService.js";
import { AgentSession, type AgentSessionHost } from "../agents/AgentSession.js";
import { AgentServiceLocator } from "../harness/AgentServiceLocator.js";
import { ClaudeCodeStrategy } from "../harness/ClaudeCodeStrategy.js";
import type { AgentStrategy } from "../harness/AgentStrategy.js";
import type { AppEvent } from "../harness/appEvent.js";
import { NotificationService } from "../notify/NotificationService.js";
import type { ClaudeCodeHookEvent } from "../harness/ClaudeCodeStrategy.js";
import type { Harness } from "../protocol/types.js";
import {
  findAgent,
  installStateFor,
  readInstalledStamp,
  writeInstalledStamp,
} from "../welcome/agents.js";
import { readPluginVersion } from "../bridge/PluginInstaller.js";
import { runMapperFixtures } from "./harnessFixtures.js";

const noopHost: AgentSessionHost = {
  isWindowFocused: () => false,
  onChanged: () => {},
  stopSettleMs: 0,
};

function mkSession(harness: Harness, supportsLiveness: boolean): AgentSession {
  return new AgentSession(
    "s",
    "/repo",
    harness,
    supportsLiveness,
    noopHost,
    new NotificationService(),
  );
}

suite("AgentSession.shouldRemoveAfterSilence (liveness-less sweep fallback)", () => {
  const now = 2_000_000_000;
  const silent = now - LIVENESS_LESS_REMOVE_MS_FOR_TEST - 1;

  test("a liveness-less session silent past the window in a non-active state is removable", () => {
    const s = mkSession("codex", false);
    s.lastEventAt = silent; // idle (the constructor's default) is non-active
    assert.strictEqual(s.shouldRemoveAfterSilence(now), true);
  });

  test("a liveness-CAPABLE session is never removed this way, however silent", () => {
    for (const harness of ["claudecode", "opencode"] as Harness[]) {
      const s = mkSession(harness, true);
      s.lastEventAt = silent;
      assert.strictEqual(s.shouldRemoveAfterSilence(now), false, harness);
    }
  });

  test("recent silence does not trigger removal", () => {
    const s = mkSession("codex", false);
    s.lastEventAt = now - 1000;
    assert.strictEqual(s.shouldRemoveAfterSilence(now), false);
  });

  test("an active state is never removed (the idle downgrade must happen first)", () => {
    const s = mkSession("codex", false);
    s.state = "thinking";
    s.lastEventAt = silent;
    assert.strictEqual(s.shouldRemoveAfterSilence(now), false);
  });

  test("an already-ended session is not re-removed here", () => {
    const s = mkSession("codex", false);
    s.state = "ended";
    s.lastEventAt = silent;
    assert.strictEqual(s.shouldRemoveAfterSilence(now), false);
  });
});

suite("AgentSessionService sweep removes only liveness-less silent sessions", () => {
  const mk = (harness: Harness): AppEvent => ({
    kind: "sessionStart",
    harness,
    sessionId: `${harness}-1`,
    backgroundTaskCount: 0,
    sessionCronCount: 0,
  });

  test("codex row is dropped after prolonged silence; claude/opencode survive", () => {
    // The real strategies already carry the right supportsLiveness (claude/opencode true, codex
    // false), so the production locator drives this directly — no fake registration needed.
    const svc = new AgentSessionService(new AgentServiceLocator());
    try {
      svc.ingest(mk("claudecode"), "/repo");
      svc.ingest(mk("codex"), "/repo");
      svc.ingest(mk("opencode"), "/repo");
      assert.strictEqual(svc.sessionsForRepo("/repo").length, 3);

      // Age every session past the removal window, then run the (private) sweep.
      const old = Date.now() - LIVENESS_LESS_REMOVE_MS_FOR_TEST - 1;
      for (const s of svc.sessionsForRepo("/repo")) {
        s.lastEventAt = old;
      }
      (svc as unknown as { sweepStale: () => void }).sweepStale();

      const remaining = svc
        .sessionsForRepo("/repo")
        .map((s) => s.harness)
        .sort();
      assert.deepStrictEqual(remaining, ["claudecode", "opencode"]);
    } finally {
      svc.dispose();
    }
  });

  test("an attached codex session (MCP liveness holding its socket) is never silence-swept", () => {
    const svc = new AgentSessionService(new AgentServiceLocator());
    try {
      svc.ingest(mk("codex"), "/repo");
      // The bundled MCP liveness server attached — the held socket proves the process is alive,
      // however long the user leaves the TUI idle.
      svc.attachSession("codex-1");
      for (const s of svc.sessionsForRepo("/repo")) {
        s.lastEventAt = Date.now() - LIVENESS_LESS_REMOVE_MS_FOR_TEST - 1;
      }
      (svc as unknown as { sweepStale: () => void }).sweepStale();
      assert.strictEqual(svc.sessionsForRepo("/repo").length, 1, "attached row survives the sweep");

      // The liveness drop is the real cleanup path: detaching removes the row immediately.
      svc.detachSession("codex-1");
      assert.strictEqual(svc.sessionsForRepo("/repo").length, 0, "socket drop removes it");
    } finally {
      svc.dispose();
    }
  });
});

suite("onboarding install stamp + installedProbe", () => {
  let dir: string;
  const pluginsRoot = path.resolve(__dirname, "../../plugins");

  setup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "paireto-stamp-"));
  });
  teardown(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("read/writeInstalledStamp round-trips; absent reads undefined", () => {
    assert.strictEqual(readInstalledStamp(dir), undefined);
    writeInstalledStamp(dir, "1.2.3");
    assert.strictEqual(readInstalledStamp(dir), "1.2.3");
  });

  test("installStateFor is the tri-state version comparison", () => {
    assert.strictEqual(installStateFor(undefined, "1.2.3"), "not-installed");
    assert.strictEqual(installStateFor("1.2.3", "1.2.3"), "installed");
    assert.strictEqual(installStateFor("1.2.2", "1.2.3"), "update-available");
  });

  test("claude installedProbe is tri-state: absent → not-installed, stale → update-available", () => {
    const claude = findAgent("claude-code");
    assert.ok(claude?.installedProbe);
    const ctx = { pluginsRoot, stableDir: dir };
    const shipped = readPluginVersion(pluginsRoot);

    assert.strictEqual(claude.installedProbe(ctx), "not-installed", "no stamp yet");
    writeInstalledStamp(dir, "0.0.0-stale");
    assert.strictEqual(claude.installedProbe(ctx), "update-available", "stale stamp");
    writeInstalledStamp(dir, shipped);
    assert.strictEqual(claude.installedProbe(ctx), "installed", "current stamp");
  });

  test("codex + opencode are available with an installer and a probe", () => {
    for (const id of ["codex", "opencode"]) {
      const agent = findAgent(id);
      assert.strictEqual(agent?.available, true, `${id} available`);
      assert.ok(agent?.install, `${id} has an installer`);
      assert.ok(agent?.installedProbe, `${id} has a probe`);
    }
  });
});

suite("mapper-fixture helper (claudecode parity demo)", () => {
  const claude: AgentStrategy = new ClaudeCodeStrategy();
  const base = { session_id: "s1", transcript_path: "t", cwd: "/repo" };

  runMapperFixtures(claude, [
    {
      name: "SessionStart → sessionStart",
      raw: { ...base, hook_event_name: "SessionStart" } as ClaudeCodeHookEvent,
      expect: { kind: "sessionStart", harness: "claudecode", sessionId: "s1" },
    },
    {
      name: "PreToolUse ExitPlanMode → planProposal with plan text",
      raw: {
        ...base,
        hook_event_name: "PreToolUse",
        tool_name: "ExitPlanMode",
        tool_input: { plan: "do the thing" },
      } as ClaudeCodeHookEvent,
      expect: { kind: "planProposal", planText: "do the thing" },
    },
    {
      name: "PreToolUse Edit → preToolUse, isEditTool true",
      raw: {
        ...base,
        hook_event_name: "PreToolUse",
        tool_name: "Edit",
      } as ClaudeCodeHookEvent,
      expect: { kind: "preToolUse", toolName: "Edit", isEditTool: true },
    },
    {
      name: "PostToolUse Read → postToolUse, isEditTool false",
      raw: {
        ...base,
        hook_event_name: "PostToolUse",
        tool_name: "Read",
      } as ClaudeCodeHookEvent,
      expect: { kind: "postToolUse", isEditTool: false },
    },
    {
      name: "an unsubscribed hook name is dropped",
      raw: { ...base, hook_event_name: "PreCompact" } as unknown as ClaudeCodeHookEvent,
      expect: null,
    },
  ]);
});

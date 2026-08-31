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
import { findAgent, writeInstalledStamp } from "../welcome/agents.js";
import { installProbeFor, installStateFor } from "../welcome/installProbe.js";
import { readClaudePluginVersion } from "../bridge/ClaudeInstaller.js";
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

suite("AgentSessionService.getSessionById", () => {
  // A tool call can be an agent's first contact — the gate it opens needs a real row to own, not a
  // stand-in name.
  test("registers a session the service has never seen, then returns that same one", () => {
    const svc = new AgentSessionService(new AgentServiceLocator());
    try {
      const created = svc.getSessionById("s-1", "/repo", "codex");
      assert.strictEqual(created.harness, "codex");
      assert.strictEqual(created.repoRoot, "/repo");
      assert.strictEqual(svc.sessionsForRepo("/repo").length, 1);

      const again = svc.getSessionById("s-1", "/repo", "codex");
      assert.strictEqual(again, created, "an existing row is reused, never replaced");
      assert.strictEqual(svc.sessionsForRepo("/repo").length, 1);
    } finally {
      svc.dispose();
    }
  });

  test("keeps the harness the session already had", () => {
    const svc = new AgentSessionService(new AgentServiceLocator());
    try {
      svc.ingest(
        {
          kind: "sessionStart",
          harness: "claudecode",
          sessionId: "s-2",
          backgroundTaskCount: 0,
          sessionCronCount: 0,
        },
        "/repo",
      );
      assert.strictEqual(svc.getSessionById("s-2", "/repo", "codex").harness, "claudecode");
    } finally {
      svc.dispose();
    }
  });
});

suite("onboarding install stamp + installedProbe", () => {
  let dir: string;
  const pluginsRoot = path.resolve(__dirname, "../../dist/plugins");

  setup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "paireto-stamp-"));
  });
  teardown(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("writeInstalledStamp records the version for the probe that reads it", () => {
    writeInstalledStamp(dir, "1.2.3");
    assert.strictEqual(fs.readFileSync(path.join(dir, "installed-version"), "utf8"), "1.2.3");
  });

  test("installStateFor is the tri-state version comparison", () => {
    assert.strictEqual(installStateFor(undefined, "1.2.3"), "not-installed");
    assert.strictEqual(installStateFor("1.2.3", "1.2.3"), "installed");
    assert.strictEqual(installStateFor("1.2.2", "1.2.3"), "update-available");
  });

  // The card prints these two numbers next to the badge, so the badge has to be derived from them.
  // A probe answering from a marker this extension wrote would read "installed" while the agent
  // served an older bundle — precisely when the bridge refuses it.
  test("installProbeFor derives the badge from the two versions it reports", () => {
    assert.deepStrictEqual(installProbeFor("1.2.3", "1.2.3"), {
      state: "installed",
      installedVersion: "1.2.3",
      shippedVersion: "1.2.3",
    });
    assert.deepStrictEqual(installProbeFor("1.2.2", "1.2.3"), {
      state: "update-available",
      installedVersion: "1.2.2",
      shippedVersion: "1.2.3",
    });
  });

  test("an agent carrying nothing reports nothing to show", () => {
    assert.deepStrictEqual(installProbeFor(undefined, "1.2.3"), { state: "not-installed" });
  });

  test("claude measures against the version this extension ships", async () => {
    const claude = findAgent("claude-code");
    assert.ok(claude);
    const probe = await claude.installedProbe({ pluginsRoot, stableDir: dir });
    if (probe.state !== "not-installed") {
      assert.strictEqual(probe.shippedVersion, readClaudePluginVersion(pluginsRoot));
    }
  });

  test("every available agent has an installer", () => {
    for (const id of ["claude-code", "codex", "kiro", "opencode"]) {
      const agent = findAgent(id);
      assert.strictEqual(agent?.available, true, `${id} available`);
      assert.ok(agent?.install, `${id} has an installer`);
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
      // ExitPlanMode's `plan` argument is optional; the plugin recovers it from the plan file into
      // meta.planMarkdown, alongside the raw event.
      name: "PreToolUse ExitPlanMode with empty input → planProposal from meta.planMarkdown",
      raw: {
        ...base,
        hook_event_name: "PreToolUse",
        tool_name: "ExitPlanMode",
        tool_input: {},
      } as ClaudeCodeHookEvent,
      meta: { planMarkdown: "recovered from the plan file" },
      expect: { kind: "planProposal", planText: "recovered from the plan file" },
    },
    {
      name: "PreToolUse ExitPlanMode with blank plan → planProposal from meta.planMarkdown",
      raw: {
        ...base,
        hook_event_name: "PreToolUse",
        tool_name: "ExitPlanMode",
        tool_input: { plan: "  \n" },
      } as ClaudeCodeHookEvent,
      meta: { planMarkdown: "recovered from the named plan file" },
      expect: { kind: "planProposal", planText: "recovered from the named plan file" },
    },
    {
      name: "PreToolUse ExitPlanMode → the tool's own plan wins over meta",
      raw: {
        ...base,
        hook_event_name: "PreToolUse",
        tool_name: "ExitPlanMode",
        tool_input: { plan: "do the thing" },
      } as ClaudeCodeHookEvent,
      meta: { planMarkdown: "stale file contents" },
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

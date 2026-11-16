import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

import type { OnboardingAgent } from "../welcome/agents.js";
import { AgentInstallStatus, type AgentStatusRow } from "../welcome/AgentInstallStatus.js";
import { installProbeFor } from "../welcome/installProbe.js";

const storage = fs.mkdtempSync(path.join(os.tmpdir(), "paireto-install-status-"));

const context = {
  extensionUri: vscode.Uri.file("/fake/extension"),
  globalStorageUri: vscode.Uri.file(storage),
} as unknown as vscode.ExtensionContext;

interface Gate {
  promise: Promise<void>;
  open: () => void;
}

function gate(): Gate {
  let open = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

interface FakeWorld {
  shipped: string;
  installed?: string;
  probes: number;
  installs: number;
  probeWait: () => Promise<void>;
  installWait: () => Promise<void>;
  installThrows: boolean;
}

function fakeAgent(
  id: string,
  world: Partial<FakeWorld> = {},
): { agent: OnboardingAgent; world: FakeWorld } {
  const w: FakeWorld = {
    shipped: "2.0.0",
    probes: 0,
    installs: 0,
    probeWait: () => Promise.resolve(),
    installWait: () => Promise.resolve(),
    installThrows: false,
    ...world,
  };
  const agent: OnboardingAgent = {
    id,
    name: `${id} agent`,
    available: true,
    installedProbe: async () => {
      w.probes += 1;
      const seen = w.installed;
      await w.probeWait();
      return installProbeFor(seen, w.shipped);
    },
    install: async () => {
      w.installs += 1;
      if (w.installThrows) {
        throw new Error("installer blew up");
      }
      w.installed = undefined;
      await w.installWait();
      w.installed = w.shipped;
      return { ok: true, detail: "installed" };
    },
  };
  return { agent, world: w };
}

function rowFor(status: AgentInstallStatus, id: string): AgentStatusRow | undefined {
  return status.snapshot().find((r) => r.id === id);
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

suite("agent install status cache", () => {
  suiteTeardown(() => {
    fs.rmSync(storage, { recursive: true, force: true });
  });

  test("a scheduled probe does not run again when a refresh gets there first", async () => {
    const codex = fakeAgent("codex", { installed: "2.0.0" });
    const status = new AgentInstallStatus(context, [codex.agent]);
    try {
      status.scheduleRefresh();
      await status.refresh();
      await tick();
      assert.strictEqual(codex.world.probes, 1, "the agent must be asked once");
    } finally {
      status.dispose();
    }
  });

  test("refreshes asked for before a probe starts share that probe", async () => {
    const codex = fakeAgent("codex", { installed: "2.0.0" });
    const status = new AgentInstallStatus(context, [codex.agent]);
    try {
      await Promise.all([status.refresh(), status.refresh(), status.refresh()]);
      assert.strictEqual(codex.world.probes, 1);
    } finally {
      status.dispose();
    }
  });

  test("a refresh asked for while a probe runs reads the state after the ask", async () => {
    const probeGate = gate();
    const codex = fakeAgent("codex", { probeWait: () => probeGate.promise });
    const status = new AgentInstallStatus(context, [codex.agent]);
    try {
      const before = status.refresh();
      await tick();
      codex.world.installed = "2.0.0";
      const after = status.refresh();
      probeGate.open();
      await Promise.all([before, after]);
      assert.strictEqual(rowFor(status, "codex")?.installState, "installed");
      assert.strictEqual(codex.world.probes, 2);
    } finally {
      status.dispose();
    }
  });

  test("onDidChange fires for a row that moved, and stays quiet when nothing did", async () => {
    const codex = fakeAgent("codex");
    const status = new AgentInstallStatus(context, [codex.agent]);
    let fired = 0;
    const sub = status.onDidChange(() => {
      fired += 1;
    });
    try {
      await status.refresh();
      assert.strictEqual(fired, 1, "the first result is a change from nothing");
      codex.world.installed = "2.0.0";
      await status.refresh();
      assert.strictEqual(fired, 2, "not-installed became installed");
      await status.refresh();
      assert.strictEqual(fired, 2, "an unchanged result must not fire");
    } finally {
      sub.dispose();
      status.dispose();
    }
  });

  test("the nudge waits until every agent has answered", async () => {
    const slowGate = gate();
    const codex = fakeAgent("codex");
    const claude = fakeAgent("claude-code", {
      installed: "2.0.0",
      probeWait: () => slowGate.promise,
    });
    const status = new AgentInstallStatus(context, [claude.agent, codex.agent]);
    try {
      assert.deepStrictEqual(status.snapshot(), []);
      const refreshed = status.refresh();
      await tick();
      assert.deepStrictEqual(
        status.snapshot().map((r) => r.id),
        ["codex"],
        "an agent that answered shows while a slow one is still asked",
      );
      assert.strictEqual(status.prompt(), undefined, "no nudge may flash before all answer");
      slowGate.open();
      await refreshed;
      assert.deepStrictEqual(
        status.snapshot().map((r) => r.id),
        ["claude-code", "codex"],
        "rows keep registry order",
      );
      assert.strictEqual(status.prompt(), undefined, "one working agent is enough");
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

  test("an install that finishes during a probe started before it shows as installed", async () => {
    const probeGate = gate();
    let holdProbes = true;
    const codex = fakeAgent("codex", {
      installed: "1.0.0",
      probeWait: () => (holdProbes ? probeGate.promise : Promise.resolve()),
    });
    const status = new AgentInstallStatus(context, [codex.agent]);
    try {
      const staleProbe = status.refresh();
      await tick();
      holdProbes = false;
      const installed = status.install("codex");
      probeGate.open();
      await Promise.all([staleProbe, installed]);
      const row = rowFor(status, "codex");
      assert.strictEqual(row?.installState, "installed");
      assert.strictEqual(row?.installedVersion, "2.0.0");
      assert.strictEqual(row?.installing, false);
    } finally {
      status.dispose();
    }
  });

  test("an agent is never probed while it installs, and its row never shows a guess", async () => {
    const installGate = gate();
    const codex = fakeAgent("codex", {
      installed: "1.0.0",
      installWait: () => installGate.promise,
    });
    const status = new AgentInstallStatus(context, [codex.agent]);
    const seen: Array<[boolean, string]> = [];
    const sub = status.onDidChange(() => {
      const row = rowFor(status, "codex");
      if (row) {
        seen.push([row.installing, row.installState]);
      }
    });
    try {
      await status.refresh();
      const installed = status.install("codex");
      await tick();
      const probesDuringInstall = codex.world.probes;
      await status.refresh();
      await status.refresh();
      await tick();
      assert.strictEqual(codex.world.probes, probesDuringInstall, "no probe during the install");
      assert.deepStrictEqual(rowFor(status, "codex")?.installing, true);
      installGate.open();
      await installed;
      assert.deepStrictEqual(seen, [
        [false, "update-available"],
        [true, "update-available"],
        [false, "installed"],
      ]);
    } finally {
      sub.dispose();
      status.dispose();
    }
  });

  test("a stuck install holds back only its own agent", async () => {
    const stuck = fakeAgent("claude-code", {
      installed: "1.0.0",
      installWait: () => new Promise<void>(() => undefined),
    });
    const codex = fakeAgent("codex", { installed: "1.0.0" });
    const kiro = fakeAgent("kiro");
    const status = new AgentInstallStatus(context, [stuck.agent, codex.agent, kiro.agent]);
    try {
      await status.refresh();
      void status.install("claude-code");
      await Promise.all([status.install("codex"), status.install("kiro")]);
      await status.refresh();
      assert.strictEqual(rowFor(status, "codex")?.installState, "installed");
      assert.strictEqual(rowFor(status, "kiro")?.installState, "installed");
      assert.strictEqual(rowFor(status, "claude-code")?.installing, true);
    } finally {
      status.dispose();
    }
  });

  test("a second install request while one runs does not run the installer again", async () => {
    const installGate = gate();
    const codex = fakeAgent("codex", { installWait: () => installGate.promise });
    const status = new AgentInstallStatus(context, [codex.agent]);
    try {
      await status.refresh();
      const first = status.install("codex");
      const second = status.install("codex");
      installGate.open();
      await Promise.all([first, second]);
      assert.strictEqual(codex.world.installs, 1);
      assert.strictEqual(rowFor(status, "codex")?.installState, "installed");
    } finally {
      status.dispose();
    }
  });

  test("an installer that throws still leaves a probed row that is not installing", async () => {
    const codex = fakeAgent("codex", { installed: "1.0.0", installThrows: true });
    const status = new AgentInstallStatus(context, [codex.agent]);
    try {
      await status.refresh();
      await status.install("codex");
      const row = rowFor(status, "codex");
      assert.strictEqual(row?.installState, "update-available");
      assert.strictEqual(row?.installing, false);
    } finally {
      status.dispose();
    }
  });

  test("every install clicked down the list shows installed the moment it finishes", async () => {
    const random = mulberry32(0x5eed);
    const wait = (): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, Math.floor(random() * 4)));
    const fakes = ["claude-code", "codex", "opencode", "kiro", "pi"].map((id, i) =>
      fakeAgent(id, {
        shipped: "1.0.0",
        installed: i % 2 === 0 ? undefined : "0.9.0",
        probeWait: wait,
        installWait: wait,
      }),
    );
    const status = new AgentInstallStatus(
      context,
      fakes.map((f) => f.agent),
    );
    const failures: string[] = [];
    try {
      for (let round = 0; round < 25; round++) {
        const shipped = `1.${round}.0`;
        for (const f of fakes) {
          f.world.shipped = shipped;
        }
        void status.refresh();
        const order = [...fakes].sort(() => random() - 0.5);
        const installs: Promise<void>[] = [];
        for (const f of order) {
          if (random() < 0.5) {
            void status.refresh();
          }
          installs.push(
            status.install(f.agent.id).then(() => {
              const row = rowFor(status, f.agent.id);
              if (
                row?.installState !== "installed" ||
                row.installedVersion !== shipped ||
                row.installing
              ) {
                failures.push(`round ${round} ${f.agent.id}: ${JSON.stringify(row)}`);
              }
            }),
          );
          await wait();
        }
        await Promise.all(installs);
        await tick();
        for (const f of fakes) {
          const row = rowFor(status, f.agent.id);
          if (row?.installState !== "installed" || row.installing) {
            failures.push(`round ${round} settled ${f.agent.id}: ${JSON.stringify(row)}`);
          }
        }
      }
      assert.deepStrictEqual(failures, []);
    } finally {
      status.dispose();
    }
  });
});

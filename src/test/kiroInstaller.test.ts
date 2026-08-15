import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  installKiro,
  kiroInstalledProbe,
  kiroFilesInstallState,
  kiroInstallPlan,
  readInstalledKiroPowerVersion,
  renderKiroHooks,
} from "../bridge/KiroInstaller.js";

suite("Kiro install plan", () => {
  test("installs the common Power in the CLI registry", () => {
    assert.deepStrictEqual(kiroInstallPlan("/extension/plugins", "/user/.kiro"), {
      sourcePlugin: "/extension/plugins/agent-plugin",
      installedPower: "/user/.kiro/powers/installed/paireto",
      registryFile: "/user/.kiro/powers/installed.json",
      hookFile: "/user/.kiro/hooks/paireto.json",
    });
  });

  test("renders unified v1 hooks with exact Plan and review gates", () => {
    const rendered = JSON.parse(renderKiroHooks("/stable path/power")) as {
      version: string;
      hooks: Array<{
        trigger: string;
        matcher?: string;
        action: { command: string };
        timeout: number;
        confirm?: unknown;
      }>;
    };
    assert.strictEqual(rendered.version, "v1");
    const plan = rendered.hooks.find((hook) => hook.matcher === "^switch_to_execution$");
    assert.strictEqual(plan?.trigger, "PreToolUse");
    assert.ok(
      plan?.action.command.includes('"/stable path/power/dev.kiro/runtime/on-plan-gate.js"'),
    );
    assert.strictEqual(plan?.confirm, undefined);
    const stopCommands = rendered.hooks
      .filter((hook) => hook.trigger === "Stop")
      .map((hook) => hook.action.command);
    assert.ok(stopCommands.some((command) => command.includes("on-event.js")));
    assert.ok(stopCommands.some((command) => command.includes("on-stop-gate.js")));
  });
});

suite("Kiro file install state", () => {
  test("distinguishes incomplete, stale, and current files", () => {
    assert.strictEqual(
      kiroFilesInstallState(false, undefined, undefined, "0.7.0"),
      "not-installed",
    );
    assert.strictEqual(kiroFilesInstallState(true, "0.7.0", undefined, "0.7.0"), "not-installed");
    assert.strictEqual(kiroFilesInstallState(true, "0.6.0", "0.6.0", "0.7.0"), "update-available");
    assert.strictEqual(kiroFilesInstallState(true, "0.7.0", "0.7.0", "0.7.0"), "installed");
  });

  test("reads only a Power that is present in the installed registry", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "paireto-kiro-powers-"));
    try {
      const power = path.join(home, "powers", "installed", "paireto");
      fs.mkdirSync(power, { recursive: true });
      fs.writeFileSync(
        path.join(power, "plugin.json"),
        JSON.stringify({ name: "paireto", version: "0.7.0" }),
      );
      assert.strictEqual(readInstalledKiroPowerVersion(home), undefined);
      fs.writeFileSync(
        path.join(home, "powers", "installed.json"),
        JSON.stringify({ installedPowers: [{ name: "paireto" }] }),
      );
      assert.strictEqual(readInstalledKiroPowerVersion(home), "0.7.0");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

suite("Kiro installer", () => {
  test("installs the global CLI configuration without a follow-up action", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paireto-kiro-install-"));
    try {
      const pluginsRoot = path.join(root, "plugins");
      const source = path.join(pluginsRoot, "agent-plugin");
      const stableDir = path.join(root, "stable");
      const kiroHome = path.join(root, ".kiro");
      fs.mkdirSync(source, { recursive: true });
      fs.writeFileSync(
        path.join(source, "plugin.json"),
        JSON.stringify({ name: "paireto", version: "0.7.0" }),
      );
      for (const skill of ["paireto-review", "paireto-guided-review"]) {
        const skillRoot = path.join(source, "skills", skill);
        fs.mkdirSync(skillRoot, { recursive: true });
        fs.writeFileSync(path.join(skillRoot, "SKILL.md"), `# ${skill}\n`);
      }
      fs.mkdirSync(path.join(kiroHome, "hooks"), { recursive: true });
      fs.writeFileSync(path.join(kiroHome, "hooks", "foreign.json"), "foreign");
      fs.mkdirSync(path.join(kiroHome, "settings"), { recursive: true });
      fs.writeFileSync(
        path.join(kiroHome, "settings", "mcp.json"),
        JSON.stringify({
          mcpServers: { foreign: { command: "foreign-server" } },
          userSetting: true,
        }),
      );
      fs.mkdirSync(path.join(kiroHome, "powers"), { recursive: true });
      fs.writeFileSync(
        path.join(kiroHome, "powers", "installed.json"),
        JSON.stringify({
          installedPowers: [{ name: "foreign", source: "https://example.com/foreign" }],
          userSetting: true,
        }),
      );

      const result = await installKiro({ pluginsRoot, stableDir }, { kiroHome });

      assert.strictEqual(result.ok, true);
      const installedPower = path.join(kiroHome, "powers", "installed", "paireto");
      assert.ok(fs.existsSync(path.join(installedPower, "plugin.json")));
      assert.ok(!fs.existsSync(path.join(stableDir, "power")));
      assert.ok(fs.existsSync(path.join(kiroHome, "hooks", "paireto.json")));
      assert.ok(
        fs
          .readFileSync(path.join(kiroHome, "hooks", "paireto.json"), "utf8")
          .includes(installedPower),
      );
      assert.deepStrictEqual(
        JSON.parse(fs.readFileSync(path.join(kiroHome, "settings", "mcp.json"), "utf8")),
        {
          mcpServers: { foreign: { command: "foreign-server" } },
          userSetting: true,
        },
      );
      assert.deepStrictEqual(
        JSON.parse(fs.readFileSync(path.join(kiroHome, "powers", "installed.json"), "utf8")),
        {
          installedPowers: [
            { name: "foreign", source: "https://example.com/foreign" },
            { name: "paireto" },
          ],
          userSetting: true,
        },
      );
      assert.strictEqual(
        fs.readFileSync(path.join(stableDir, "installed-version"), "utf8"),
        "0.7.0\n",
      );
      assert.strictEqual(
        fs.readFileSync(path.join(kiroHome, "hooks", "foreign.json"), "utf8"),
        "foreign",
      );
      assert.strictEqual((await installKiro({ pluginsRoot, stableDir }, { kiroHome })).ok, true);
      assert.strictEqual(kiroInstalledProbe({ pluginsRoot, stableDir }, { kiroHome }), "installed");
      fs.writeFileSync(
        path.join(kiroHome, "powers", "installed.json"),
        JSON.stringify({ installedPowers: [{ name: "foreign" }] }),
      );
      assert.strictEqual(
        kiroInstalledProbe({ pluginsRoot, stableDir }, { kiroHome }),
        "not-installed",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("updates an existing Paireto Power in place", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paireto-kiro-update-"));
    try {
      const pluginsRoot = path.join(root, "plugins");
      const source = path.join(pluginsRoot, "agent-plugin");
      const stableDir = path.join(root, "stable");
      const kiroHome = path.join(root, ".kiro");
      const existing = path.join(kiroHome, "powers", "installed", "paireto");
      fs.mkdirSync(source, { recursive: true });
      fs.writeFileSync(
        path.join(source, "plugin.json"),
        JSON.stringify({ name: "paireto", version: "0.7.0" }),
      );
      fs.writeFileSync(path.join(source, "current.txt"), "current");
      for (const skill of ["paireto-review", "paireto-guided-review"]) {
        const skillRoot = path.join(source, "skills", skill);
        fs.mkdirSync(skillRoot, { recursive: true });
        fs.writeFileSync(path.join(skillRoot, "SKILL.md"), `# ${skill}\n`);
      }
      fs.mkdirSync(existing, { recursive: true });
      fs.writeFileSync(
        path.join(existing, "plugin.json"),
        JSON.stringify({ name: "paireto", version: "0.6.0" }),
      );
      fs.writeFileSync(path.join(existing, "stale.txt"), "stale");
      fs.writeFileSync(
        path.join(kiroHome, "powers", "installed.json"),
        JSON.stringify({ installedPowers: [{ name: "paireto", source: "local" }] }),
      );

      const result = await installKiro({ pluginsRoot, stableDir }, { kiroHome });

      assert.strictEqual(result.ok, true);
      assert.ok(fs.existsSync(path.join(existing, "current.txt")));
      assert.ok(!fs.existsSync(path.join(existing, "stale.txt")));
      assert.ok(
        fs.readFileSync(path.join(kiroHome, "hooks", "paireto.json"), "utf8").includes(existing),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not overwrite a malformed Power registry", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paireto-kiro-invalid-registry-"));
    try {
      const pluginsRoot = path.join(root, "plugins");
      const source = path.join(pluginsRoot, "agent-plugin");
      const stableDir = path.join(root, "stable");
      const kiroHome = path.join(root, ".kiro");
      fs.mkdirSync(source, { recursive: true });
      fs.writeFileSync(
        path.join(source, "plugin.json"),
        JSON.stringify({ name: "paireto", version: "0.7.0" }),
      );
      for (const skill of ["paireto-review", "paireto-guided-review"]) {
        const skillRoot = path.join(source, "skills", skill);
        fs.mkdirSync(skillRoot, { recursive: true });
        fs.writeFileSync(path.join(skillRoot, "SKILL.md"), `# ${skill}\n`);
      }
      const registryFile = path.join(kiroHome, "powers", "installed.json");
      fs.mkdirSync(path.dirname(registryFile), { recursive: true });
      fs.writeFileSync(registryFile, "{not json\n");

      const result = await installKiro({ pluginsRoot, stableDir }, { kiroHome });

      assert.strictEqual(result.ok, false);
      assert.strictEqual(fs.readFileSync(registryFile, "utf8"), "{not json\n");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

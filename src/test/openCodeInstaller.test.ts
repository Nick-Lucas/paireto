// Coverage for the OpenCode installer's file-shape logic: the install plan (which shipped artifact
// copies to which config-dir target), the adapter-version parsing used by the probe, and the shipped-
// manifest reader's shape assertion. The plan enumerates the REAL shipped bundle, so these assert
// against what esbuild actually built into `dist/plugins/opencode`; nothing touches a real config.

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  openCodeInstallPlan,
  openCodeInstallState,
  parseAdapterVersion,
  readOpenCodeAdapterVersion,
} from "../bridge/OpenCodeInstaller.js";

suite("openCodeInstallPlan", () => {
  // The real built bundle, so a file added to the OpenCode plugin is installed without touching this.
  const pluginsRoot = path.resolve(__dirname, "../../dist/plugins");
  const plan = openCodeInstallPlan(pluginsRoot, "/home/.config/opencode");
  const targets = plan.map((c) => c.to);

  test("installs every file the bundle ships, in place (no version staging)", () => {
    const shipped = fs
      .readdirSync(path.join(pluginsRoot, "opencode"), { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
    assert.ok(shipped.includes("paireto.js"), "the plugin itself is shipped");
    for (const name of shipped) {
      assert.ok(
        targets.includes(`/home/.config/opencode/plugin/${name}`),
        `${name} must be installed`,
      );
    }
  });

  test("installs every shipped command into the commands/ dir (plural)", () => {
    const commands = fs.readdirSync(path.join(pluginsRoot, "opencode", "commands"));
    assert.ok(commands.length > 0, "the bundle ships at least one command");
    for (const name of commands) {
      assert.ok(
        targets.includes(`/home/.config/opencode/commands/${name}`),
        `${name} must be installed`,
      );
    }
  });

  test("writes only our own filenames — never a recursive copy that could clobber a foreign subtree", () => {
    assert.ok(
      plan.every((c) => path.basename(c.from) === path.basename(c.to)),
      "each copy keeps its own filename",
    );
    assert.strictEqual(new Set(targets).size, targets.length, "no target is written twice");
    for (const target of targets) {
      const parent = path.dirname(target);
      assert.ok(
        parent === "/home/.config/opencode/plugin" || parent === "/home/.config/opencode/commands",
        `${target} must land directly in a dir we own`,
      );
    }
  });
});

suite("parseAdapterVersion", () => {
  test("returns the version string from a valid manifest", () => {
    assert.strictEqual(parseAdapterVersion('{"name":"x","version":"1.2.3"}'), "1.2.3");
  });

  test("returns undefined for malformed / missing / non-string version", () => {
    assert.strictEqual(parseAdapterVersion(""), undefined);
    assert.strictEqual(parseAdapterVersion("not json"), undefined);
    assert.strictEqual(parseAdapterVersion("{}"), undefined);
    assert.strictEqual(parseAdapterVersion('{"version":3}'), undefined);
  });
});

suite("openCodeInstallState (tri-state probe)", () => {
  test("matching version → installed", () => {
    assert.strictEqual(openCodeInstallState('{"version":"1.2.3"}', "1.2.3"), "installed");
  });

  test("present but a different version → update-available", () => {
    assert.strictEqual(openCodeInstallState('{"version":"1.2.2"}', "1.2.3"), "update-available");
  });

  test("absent / malformed adapter.json → not-installed", () => {
    assert.strictEqual(openCodeInstallState("", "1.2.3"), "not-installed");
    assert.strictEqual(openCodeInstallState("not json", "1.2.3"), "not-installed");
    assert.strictEqual(openCodeInstallState("{}", "1.2.3"), "not-installed");
  });
});

suite("readOpenCodeAdapterVersion (shipped manifest)", () => {
  test("reads the real shipped dist/plugins/opencode/adapter.json", () => {
    const pluginsRoot = path.resolve(__dirname, "../../dist/plugins");
    const version = readOpenCodeAdapterVersion(pluginsRoot);
    assert.ok(/^\d+\.\d+\.\d+/.test(version), `version looks semver-ish: ${version}`);
  });

  test("throws (packaging bug) when the manifest is absent", () => {
    assert.throws(() => readOpenCodeAdapterVersion("/nonexistent/plugins"));
  });
});

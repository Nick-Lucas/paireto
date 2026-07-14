// Pure-function coverage for the OpenCode installer's file-shape logic: the three-file install plan
// (which shipped artifact copies to which config-dir target), the adapter-version parsing used by the
// probe, and the shipped-manifest reader's shape assertion. All run without touching any real OpenCode
// config (the plan is pure paths; version parsing is pure over a JSON string).

import * as assert from "node:assert";
import * as path from "node:path";

import {
  openCodeInstallPlan,
  openCodeInstallState,
  parseAdapterVersion,
  readOpenCodeAdapterVersion,
} from "../bridge/OpenCodeInstaller.js";

suite("openCodeInstallPlan", () => {
  const plan = openCodeInstallPlan("/ext/plugins", "/home/.config/opencode");

  test("copies the plugin + its manifest into the plugin dir, in place (no version staging)", () => {
    const byTarget = new Map(plan.map((c) => [c.to, c.from]));
    assert.strictEqual(
      byTarget.get("/home/.config/opencode/plugin/paireto.js"),
      "/ext/plugins/opencode/paireto.js",
    );
    assert.strictEqual(
      byTarget.get("/home/.config/opencode/plugin/adapter.json"),
      "/ext/plugins/opencode/adapter.json",
    );
  });

  test("copies the command into the commands/ dir (plural)", () => {
    const byTarget = new Map(plan.map((c) => [c.to, c.from]));
    assert.strictEqual(
      byTarget.get("/home/.config/opencode/commands/paireto-review.md"),
      "/ext/plugins/opencode/commands/paireto-review.md",
    );
  });

  test("only our three files — never a broad dir copy that could clobber foreign plugins", () => {
    assert.strictEqual(plan.length, 3);
    assert.ok(
      plan.every((c) => path.basename(c.from) === path.basename(c.to)),
      "each copy keeps its own filename",
    );
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
  test("reads the real shipped plugins/opencode/adapter.json", () => {
    const pluginsRoot = path.resolve(__dirname, "../../plugins");
    const version = readOpenCodeAdapterVersion(pluginsRoot);
    assert.ok(/^\d+\.\d+\.\d+/.test(version), `version looks semver-ish: ${version}`);
  });

  test("throws (packaging bug) when the manifest is absent", () => {
    assert.throws(() => readOpenCodeAdapterVersion("/nonexistent/plugins"));
  });
});

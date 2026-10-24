import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { stagePluginSdkInstall } from "../e2e/drivers/opencode.js";

const PLUGIN = "@opencode-ai/plugin";

suite("E2E OpenCode plugin SDK staging", () => {
  let root: string;

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "paireto-opencode-sdk-"));
  });

  teardown(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("a staged config dir already satisfies OpenCode's plugin SDK install", () => {
    const install = path.join(root, "sdk");
    const configDir = path.join(root, "config", "opencode");
    fs.mkdirSync(path.join(install, "node_modules", PLUGIN), { recursive: true });
    fs.writeFileSync(path.join(install, "node_modules", PLUGIN, "package.json"), "{}");
    fs.writeFileSync(
      path.join(install, "package.json"),
      JSON.stringify({ dependencies: { [PLUGIN]: "^1.19.4" } }),
    );
    fs.writeFileSync(
      path.join(install, "package-lock.json"),
      JSON.stringify({ packages: { "": { dependencies: { [PLUGIN]: "^1.19.4" } } } }),
    );
    fs.mkdirSync(configDir, { recursive: true });

    stagePluginSdkInstall(install, configDir);

    const lock = JSON.parse(fs.readFileSync(path.join(configDir, "package-lock.json"), "utf8")) as {
      packages?: Record<string, { dependencies?: Record<string, string> }>;
    };
    assert.ok(lock.packages?.[""]?.dependencies?.[PLUGIN]);
    assert.ok(fs.existsSync(path.join(configDir, "node_modules", PLUGIN, "package.json")));
  });
});

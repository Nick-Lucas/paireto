// Coverage for the Pi installer's decision logic: the settings merge that registers the staged local
// package (Pi references a local package by absolute path, so the registration is what "installed"
// means), the version parsing behind the probe, and a real staged install against a temp agent dir.

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  installPi,
  isPackageEntry,
  parsePiPackageVersion,
  piAgentDir,
  piInstalledProbe,
  piPackageRegistered,
  readPiPackageVersion,
  stagedPackagePath,
  withPackageRegistered,
} from "../bridge/PiInstaller.js";

const PACKAGE = "/stable/adapters/pi/package";

suite("pi settings registration", () => {
  test("adds the package to an empty settings file", () => {
    const { settings, changed } = withPackageRegistered("", PACKAGE);
    assert.strictEqual(changed, true);
    assert.deepStrictEqual(settings.packages, [PACKAGE]);
  });

  test("keeps the user's other packages and settings", () => {
    const existing = JSON.stringify({ theme: "dark", packages: ["npm:someone-else"] });
    const { settings } = withPackageRegistered(existing, PACKAGE);
    assert.strictEqual(settings.theme, "dark");
    assert.deepStrictEqual(settings.packages, ["npm:someone-else", PACKAGE]);
  });

  test("is idempotent, so re-running setup never duplicates the entry", () => {
    const once = withPackageRegistered("", PACKAGE);
    const twice = withPackageRegistered(JSON.stringify(once.settings), PACKAGE);
    assert.strictEqual(twice.changed, false);
    assert.deepStrictEqual(twice.settings.packages, [PACKAGE]);
  });

  test("recognises the object form Pi also accepts", () => {
    assert.strictEqual(isPackageEntry({ source: PACKAGE, skills: [] }, PACKAGE), true);
    assert.strictEqual(isPackageEntry({ source: "npm:other" }, PACKAGE), false);
    assert.strictEqual(isPackageEntry(PACKAGE, PACKAGE), true);
  });

  test("a settings file we cannot read is refused, never overwritten", () => {
    assert.strictEqual(piPackageRegistered("{not json", PACKAGE), false);
    assert.throws(() => withPackageRegistered("{not json", PACKAGE), /will not overwrite/);
    assert.throws(() => withPackageRegistered("[1, 2]", PACKAGE), /not a JSON object/);
  });

  test("an empty settings file is treated as no settings at all", () => {
    assert.deepStrictEqual(withPackageRegistered("   ", PACKAGE).settings, { packages: [PACKAGE] });
  });
});

suite("pi package version", () => {
  const pluginsRoot = path.resolve(__dirname, "../../dist/plugins");

  test("reads the shipped manifest", () => {
    assert.match(readPiPackageVersion(pluginsRoot), /^\d+\.\d+\.\d+$/);
  });

  test("a manifest without a version reads as absent", () => {
    assert.strictEqual(parsePiPackageVersion(JSON.stringify({ name: "paireto-pi" })), undefined);
    assert.strictEqual(parsePiPackageVersion("{not json"), undefined);
  });
});

suite("pi agent dir", () => {
  test("honours Pi's own env override", () => {
    assert.strictEqual(piAgentDir({ agentDir: "/tmp/pi-agent" }), "/tmp/pi-agent");
  });

  test("defaults to the per-user agent dir", () => {
    assert.strictEqual(piAgentDir({}), path.join(os.homedir(), ".pi", "agent"));
  });
});

suite("pi install", () => {
  const pluginsRoot = path.resolve(__dirname, "../../dist/plugins");
  let home: string;

  setup(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "pai-pi-install-"));
  });

  teardown(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  test("stages the package and registers it, and the probe then reports it installed", async () => {
    const stableDir = path.join(home, "stable");
    const agentDir = path.join(home, "agent");
    const result = await installPi({ pluginsRoot, stableDir }, { agentDir });
    assert.strictEqual(result.ok, true, result.detail);

    const staged = stagedPackagePath(stableDir);
    assert.ok(fs.existsSync(path.join(staged, "package.json")), "the manifest is staged");
    assert.ok(
      fs.existsSync(path.join(staged, "extensions", "paireto.js")),
      "the extension is staged",
    );
    assert.ok(
      fs.existsSync(path.join(staged, "skills", "paireto-review", "SKILL.md")),
      "the skills are staged",
    );
    const settings = fs.readFileSync(path.join(agentDir, "settings.json"), "utf8");
    assert.strictEqual(piPackageRegistered(settings, staged), true);

    assert.deepStrictEqual(piInstalledProbe({ pluginsRoot, stableDir }, { agentDir }), {
      state: "installed",
      installedVersion: readPiPackageVersion(pluginsRoot),
      shippedVersion: readPiPackageVersion(pluginsRoot),
    });
  });

  test("a package Pi no longer has registered reads as not installed", () => {
    const stableDir = path.join(home, "stable");
    const agentDir = path.join(home, "agent");
    assert.deepStrictEqual(piInstalledProbe({ pluginsRoot, stableDir }, { agentDir }), {
      state: "not-installed",
    });
  });
});

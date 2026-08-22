// Coverage for the file-based E2E spec routing. The rule decides which spec defines a (case, driver)
// pair, and it has to give the SAME answer on both sides — the host runner routing a window, and the
// shared spec inside that window deciding which drivers it still owns.

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { E2E_DRIVERS } from "../e2e/mockserver/mode.js";
import {
  casesIn,
  discoverSpecs,
  driversForSharedSpec,
  parseSpecFileName,
  specFileFor,
  specPathFor,
} from "../e2e/specRouting.js";

function specsDir(names: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paireto-specs-"));
  for (const name of names) {
    fs.writeFileSync(path.join(dir, name), "");
  }
  return dir;
}

suite("E2E spec routing", () => {
  test("a bare name defines the case for every driver", () => {
    assert.deepStrictEqual(parseSpecFileName("fullflow.e2e.js"), {
      testCase: "fullflow",
      fileName: "fullflow.e2e.js",
    });
  });

  test("a driver-suffixed name claims that one driver", () => {
    assert.deepStrictEqual(parseSpecFileName("fullflow.kiro.e2e.js"), {
      testCase: "fullflow",
      driver: "kiro",
      fileName: "fullflow.kiro.e2e.js",
    });
  });

  test("files that are not specs are ignored", () => {
    assert.strictEqual(parseSpecFileName("steps.js"), undefined);
    assert.strictEqual(parseSpecFileName("fullflow.e2e.js.map"), undefined);
  });

  // A mistyped driver would otherwise drop a pair silently, which reads exactly like a pair that was
  // never written — the one failure this suite must never hide.
  test("a spec whose suffix is not a driver fails loudly", () => {
    assert.throws(() => parseSpecFileName("fullflow.kiroo.e2e.js"), /named neither/);
    assert.throws(() => parseSpecFileName("a.b.c.e2e.js"), /named neither/);
  });

  test("an override wins for its driver, the shared spec serves the rest", () => {
    const specs = discoverSpecs(specsDir(["fullflow.e2e.js", "fullflow.kiro.e2e.js"]));
    assert.strictEqual(specFileFor(specs, "fullflow", "kiro"), "fullflow.kiro.e2e.js");
    assert.strictEqual(specFileFor(specs, "fullflow", "codex"), "fullflow.e2e.js");
  });

  test("a case defined only by overrides exists for those drivers alone", () => {
    const specs = discoverSpecs(specsDir(["kironly.kiro.e2e.js"]));
    assert.deepStrictEqual(casesIn(specs), ["kironly"]);
    assert.strictEqual(specFileFor(specs, "kironly", "kiro"), "kironly.kiro.e2e.js");
    assert.strictEqual(
      specFileFor(specs, "kironly", "codex"),
      undefined,
      "a pair with no spec is not part of the matrix",
    );
  });

  test("the shared spec drops exactly the drivers an override claims", () => {
    const dir = specsDir(["fullflow.e2e.js", "fullflow.kiro.e2e.js", "guidedreview.e2e.js"]);
    assert.deepStrictEqual(driversForSharedSpec(dir, "fullflow"), [
      "claudecode",
      "codex",
      "opencode",
    ]);
    assert.deepStrictEqual(driversForSharedSpec(dir, "guidedreview"), [
      "claudecode",
      "codex",
      "kiro",
      "opencode",
    ]);
  });

  test("cases are the union of shared and overridden specs", () => {
    const specs = discoverSpecs(
      specsDir(["fullflow.e2e.js", "fullflow.kiro.e2e.js", "manualskills.e2e.js"]),
    );
    assert.deepStrictEqual(casesIn(specs), ["fullflow", "manualskills"]);
  });

  test("the resolved path points into the specs directory", () => {
    const dir = specsDir(["fullflow.e2e.js", "fullflow.kiro.e2e.js"]);
    assert.strictEqual(
      specPathFor(dir, "fullflow", "kiro"),
      path.join(dir, "fullflow.kiro.e2e.js"),
    );
    assert.strictEqual(specPathFor(dir, "nosuchcase", "kiro"), undefined);
  });

  // The shipped specs must agree with the rule, so a new file cannot land without routing. Every
  // driver currently runs every case from the shared spec — an override is the exception, and the
  // rule itself is covered above against a temp directory.
  test("the compiled specs route every pair they claim", () => {
    const dir = path.resolve(__dirname, "..", "e2e", "tests");
    const specs = discoverSpecs(dir);
    assert.deepStrictEqual(casesIn(specs), ["fullflow", "guidedreview", "manualskills"]);
    for (const testCase of casesIn(specs)) {
      for (const driver of E2E_DRIVERS) {
        assert.strictEqual(
          specFileFor(specs, testCase, driver),
          `${testCase}.e2e.js`,
          `${testCase} @${driver}`,
        );
      }
    }
  });
});

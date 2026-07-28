// The Docker image installs the harness CLIs unpinned so the suite runs against the latest release,
// so a cassette carries the version it was recorded against and the runner names a mismatch.

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

import { platformDriftNote, versionDriftNote } from "../e2e/harnessVersion.js";
import { readFixture } from "../e2e/mockserver/MockServerController.js";
import { fixtureFileName } from "../e2e/mockserver/mode.js";

suite("harness version drift", () => {
  test("says nothing when the recorded and installed versions agree", () => {
    assert.strictEqual(versionDriftNote("claudecode", "2.1.224", "2.1.224"), undefined);
  });

  test("says nothing when the installed version can't be read", () => {
    assert.strictEqual(versionDriftNote("claudecode", "2.1.224", undefined), undefined);
  });

  test("names both versions and points at re-recording on a mismatch", () => {
    const note = versionDriftNote("claudecode", "2.1.220", "2.1.224");
    assert.ok(note);
    assert.match(note, /2\.1\.220/);
    assert.match(note, /2\.1\.224/);
    assert.match(note, /re-record/i);
  });
});

suite("cassette platform", () => {
  test("says nothing when replaying on the platform it was recorded on", () => {
    assert.strictEqual(platformDriftNote("codex", "linux", "linux"), undefined);
  });

  test("points at Docker when replaying on a different platform", () => {
    const note = platformDriftNote("codex", "linux", "darwin");
    assert.ok(note);
    assert.match(note, /linux/);
    assert.match(note, /darwin/);
    assert.match(note, /e2e:check:docker/);
  });

  test("every committed cassette records the platform it was captured on", () => {
    for (const driver of ["claudecode", "codex", "opencode"]) {
      const file = path.resolve(
        __dirname,
        `../../src/e2e/fixtures/${fixtureFileName("fullflow", driver)}`,
      );
      const fixture = readFixture(JSON.parse(fs.readFileSync(file, "utf8")), driver);
      assert.ok(fixture.recordedOn, `${driver} cassette is missing its platform stamp`);
    }
  });
});

suite("cassette envelope", () => {
  const one = { httpRequest: { method: "POST", path: "/v1/messages" } };

  test("reads a stamped cassette", () => {
    const fixture = readFixture(
      { recordedWith: { claudecode: "2.1.224" }, expectations: [one] },
      "claudecode",
    );
    assert.deepStrictEqual(fixture.recordedWith, { claudecode: "2.1.224" });
    assert.deepStrictEqual(fixture.expectations, [one]);
  });

  // The stamp is what lets a replay miss be attributed to harness drift, so it is required.
  test("rejects an unstamped cassette instead of tolerating it", () => {
    assert.throws(() => readFixture([one], "claudecode"), /re-record/i);
    assert.throws(() => readFixture({ expectations: [one] }, "claudecode"), /re-record/i);
  });

  test("rejects a cassette stamped for a different driver", () => {
    assert.throws(
      () => readFixture({ recordedWith: { codex: "0.147.0" }, expectations: [one] }, "claudecode"),
      /re-record/i,
    );
  });

  test("every committed cassette is stamped for its own driver", () => {
    for (const driver of ["claudecode", "codex", "opencode"]) {
      const file = path.resolve(
        __dirname,
        `../../src/e2e/fixtures/${fixtureFileName("fullflow", driver)}`,
      );
      const fixture = readFixture(JSON.parse(fs.readFileSync(file, "utf8")), driver);
      assert.ok(fixture.recordedWith[driver], `${driver} cassette is missing its version stamp`);
      assert.ok(fixture.expectations.length > 0, `${driver} cassette has no exchanges`);
    }
  });
});

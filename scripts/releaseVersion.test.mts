import assert from "node:assert/strict";
import { test } from "node:test";
import { formatVersion, nextStable, parseVersion, preRelease } from "./releaseVersion.mts";

const stable = (from: string, bump: "patch" | "minor" | "major") =>
  formatVersion(nextStable(parseVersion(from), bump));
const pre = (from: string, build: number) => formatVersion(preRelease(parseVersion(from), build));

test("a minor release goes to the next even minor version", () => {
  assert.equal(stable("0.30.0", "minor"), "0.32.0");
  assert.equal(stable("0.30.4", "minor"), "0.32.0");
});

test("a minor release is higher than every pre-release of the current version", () => {
  for (const from of ["0.29.0", "0.29.3", "0.30.0", "0.30.4"]) {
    const next = parseVersion(stable(from, "minor"));
    const lane = parseVersion(pre(from, 1));
    assert.ok(
      next.minor > lane.minor,
      `${from} minor -> ${formatVersion(next)} is below ${formatVersion(lane)}`,
    );
  }
});

test("patch and major releases", () => {
  assert.equal(stable("0.30.0", "patch"), "0.30.1");
  assert.equal(stable("0.29.0", "patch"), "0.29.1");
  assert.equal(stable("0.30.3", "major"), "1.0.0");
});

test("a pre-release uses the odd minor version above the stable version and the build as the patch", () => {
  assert.equal(pre("0.29.0", 6), "0.31.6");
  assert.equal(pre("0.30.0", 58), "0.31.58");
  assert.equal(pre("0.32.0", 60), "0.33.60");
  assert.equal(pre("1.0.0", 61), "1.1.61");
});

test("a version must be major.minor.patch", () => {
  assert.throws(() => parseVersion("0.29.0-canary6"));
});

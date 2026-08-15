// File-based routing from a (case, driver) pair to the spec file that defines it.
//
// `<case>.e2e.ts` defines a case for EVERY driver. `<case>.<driver>.e2e.ts` overrides that one
// driver, and is what a harness gets when its supported workflow differs from the shared one. The
// rule lives here because BOTH sides need it and must agree: the host runner picks which file a
// window loads, and the shared spec inside that window has to leave out the drivers an override
// already claims, or it would register a suite it cannot satisfy.
//
// Both sides read the compiled directory (out/e2e/tests), so the file names are the single source of
// truth — there is no list of supported pairs to keep in step with the files.

import * as fs from "node:fs";
import * as path from "node:path";

import { type E2EDriver, E2E_DRIVERS } from "./mockserver/mode.js";

/** Compiled spec extension. Specs are authored as `.e2e.ts` and run from `out/` as `.e2e.js`. */
export const SPEC_SUFFIX = ".e2e.js";

export interface SpecFile {
  testCase: string;
  /** The one driver this spec claims, or undefined when it defines the case for every driver. */
  driver?: E2EDriver;
  fileName: string;
}

function isDriver(value: string): value is E2EDriver {
  return (E2E_DRIVERS as readonly string[]).includes(value);
}

/**
 * Read a spec file name. A name that ends in the spec suffix but does not parse is an ERROR rather
 * than a file to ignore: `fullflow.kiroo.e2e.ts` would otherwise drop a case silently and read as a
 * pair that simply does not exist.
 */
export function parseSpecFileName(fileName: string): SpecFile | undefined {
  if (!fileName.endsWith(SPEC_SUFFIX)) {
    return undefined;
  }
  const parts = fileName.slice(0, -SPEC_SUFFIX.length).split(".");
  if (parts.length === 1 && parts[0] !== "") {
    return { testCase: parts[0], fileName };
  }
  if (parts.length === 2 && parts[0] !== "" && isDriver(parts[1])) {
    return { testCase: parts[0], driver: parts[1], fileName };
  }
  throw new Error(
    `spec "${fileName}" is named neither <case>${SPEC_SUFFIX} nor <case>.<driver>${SPEC_SUFFIX} ` +
      `(drivers: ${E2E_DRIVERS.join(", ")})`,
  );
}

/** Every spec in a compiled specs directory. */
export function discoverSpecs(specsDir: string): SpecFile[] {
  return fs
    .readdirSync(specsDir)
    .map(parseSpecFileName)
    .filter((spec): spec is SpecFile => spec !== undefined)
    .sort((left, right) => left.fileName.localeCompare(right.fileName));
}

/** Every case name, whether it is defined by a shared spec, driver overrides, or both. */
export function casesIn(specs: SpecFile[]): string[] {
  return [...new Set(specs.map((spec) => spec.testCase))].sort();
}

/**
 * The spec file that defines this pair: the driver's override when it has one, else the shared spec.
 * Undefined when the case has neither, which happens when a case is defined ONLY by overrides — that
 * pair has no definition and is not part of the matrix.
 */
export function specFileFor(
  specs: SpecFile[],
  testCase: string,
  driver: E2EDriver,
): string | undefined {
  const forCase = specs.filter((spec) => spec.testCase === testCase);
  const override = forCase.find((spec) => spec.driver === driver);
  return (override ?? forCase.find((spec) => spec.driver === undefined))?.fileName;
}

/**
 * The drivers a shared spec still owns — every driver minus the ones an override has claimed.
 *
 * Called by a shared spec as it registers its suites, so the drivers it declares and the pairs the
 * runner routes to it stay the same set.
 */
export function driversForSharedSpec(specsDir: string, testCase: string): E2EDriver[] {
  const claimed = new Set(
    discoverSpecs(specsDir)
      .filter((spec) => spec.testCase === testCase && spec.driver !== undefined)
      .map((spec) => spec.driver),
  );
  return E2E_DRIVERS.filter((driver) => !claimed.has(driver));
}

/** The absolute path a window loads for this pair. */
export function specPathFor(
  specsDir: string,
  testCase: string,
  driver: E2EDriver,
): string | undefined {
  const fileName = specFileFor(discoverSpecs(specsDir), testCase, driver);
  return fileName ? path.join(specsDir, fileName) : undefined;
}

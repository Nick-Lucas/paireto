// The cassette precondition for one matrix pair.
//
// A check run replays committed traffic and reaches no provider, so a pair whose cassette is
// absent cannot run at all. That is a failure of the run, not a property of the matrix: a driver
// that never launches must never be able to report a pass.

import * as fs from "node:fs";

import { type E2EMode, MODE_ENV } from "./mockserver/mode.js";

export function requireCassette(mode: E2EMode, fixturePath: string): void {
  if (mode === "check" && !fs.existsSync(fixturePath)) {
    throw new Error(`no cassette at ${fixturePath} — record it first with ${MODE_ENV}=record`);
  }
}

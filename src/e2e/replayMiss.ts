// A strict-VCR miss during replay, shared between the host runner's shim (which sees the 599) and the
// in-host test (which decides the run is over).
//
// The two live in different processes, so the miss travels through a file the runner names. The test
// polls it inside its normal step wait and aborts at the miss, instead of watching the harness retry
// the same unmatched request until an unrelated step timeout fires — the harness retries for tens of
// seconds and reports the failure as whatever it was waiting for.

import * as fs from "node:fs";

/** Env var naming the file a replay miss is recorded in (check mode only). */
export const MISS_FILE_ENV = "PAIRETO_REPLAY_MISS_FILE";

export interface ReplayMiss {
  method: string;
  path: string;
  /** Digest of the normalized body, naming the miss in the shim's log. */
  bodyDigest: string;
  /** The normalized body itself, so the runner can diff it against the cassette's match keys. */
  body: string;
}

/** The recorded miss, or undefined while replay is matching. */
export function loadReplayMiss(file = process.env[MISS_FILE_ENV]): ReplayMiss | undefined {
  if (!file) {
    return undefined;
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as ReplayMiss;
  } catch {
    return undefined;
  }
}

/** Record the FIRST miss; later retries of the same request add nothing. Best-effort. */
export function recordReplayMiss(file: string | undefined, miss: ReplayMiss): void {
  if (!file || fs.existsSync(file)) {
    return;
  }
  try {
    fs.writeFileSync(file, JSON.stringify(miss));
  } catch {
    /* the run still fails on its own timeout */
  }
}

/** The recorded miss as an operator-facing line, or undefined while replay is matching. A file that
 *  exists but cannot be parsed is still a miss — the shim only writes it when one happened. */
export function readReplayMiss(file = process.env[MISS_FILE_ENV]): string | undefined {
  const miss = loadReplayMiss(file);
  if (miss) {
    return `strict VCR miss: no cassette entry matched ${miss.method} ${miss.path}`;
  }
  return file && fs.existsSync(file) ? "strict VCR miss (detail unreadable)" : undefined;
}

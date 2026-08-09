// Shared E2E-mode contract — the ONE place that names the mode env var, the harness-facing mock URL
// env var, and the per-driver fixture file name. Imported by BOTH the host runner (runE2E.ts /
// MockServerController) and the extension-host drivers, so it must stay dependency-light (env + string
// only — no node-only or vscode imports).
//
// Modes:
//   record — harness talks to MockServer, which forwards to the real provider and captures the
//            traffic into a committable fixture (local-only; needs creds/upstream).
//   check  — harness talks to MockServer, which replays a committed fixture (NO creds, NO network).

export type E2EMode = "record" | "check";
export type E2EDriver = "claudecode" | "codex" | "opencode";
export const E2E_DRIVERS: readonly E2EDriver[] = ["claudecode", "codex", "opencode"];

/** Env var selecting the mode (unset = `record`). */
export const MODE_ENV = "PAIRETO_E2E_MODE";
/** Env var carrying the normalizing-shim URL the harness uses as its HTTP(S) proxy. */
export const MOCK_URL_ENV = "PAIRETO_MOCK_URL";
/** Env var carrying the path to MockServer's CA cert (so the harness trusts the MITM proxy). */
export const MOCK_CA_ENV = "PAIRETO_MOCK_CA";
/** Env var carrying the compiled spec the window runs — set by runE2E, read by .vscode-test.e2e.mjs. */
export const SPEC_ENV = "PAIRETO_E2E_SPEC";

/** Parse the mode from an env bag (defaults to `record`); unknown values fail loudly. */
export function resolveMode(env: NodeJS.ProcessEnv = process.env): E2EMode {
  const raw = (env[MODE_ENV] ?? "record").trim().toLowerCase();
  if (raw === "record" || raw === "check") {
    return raw;
  }
  throw new Error(`${MODE_ENV}="${raw}" is invalid — use record|check`);
}

/**
 * The title a (case, driver) suite carries, and the label its window is selected by.
 *
 * The spec builds its suite title from this, so ONE Mocha pattern selects the same thing in both
 * places: out here, where it decides which windows to open, and inside the window, where Mocha
 * applies it for real. The `@driver` tag is what makes `--grep @codex` mean "codex, every case".
 */
export function pairLabel(testCase: string, driver: E2EDriver): string {
  return `${testCase} @${driver}`;
}

/** A Mocha-style filter, as parsed off the command line. */
export interface PairFilter {
  grep?: string;
  fgrep?: string;
}

/** The pairs a filter selects. No filter selects the whole matrix. */
export function filterPairs<T extends { label: string }>(pairs: T[], filter: PairFilter): T[] {
  if (filter.fgrep) {
    return pairs.filter((pair) => pair.label.includes(filter.fgrep as string));
  }
  if (filter.grep) {
    const pattern = new RegExp(filter.grep);
    return pairs.filter((pair) => pattern.test(pair.label));
  }
  return pairs;
}

/** The committed fixture file name for a (case, driver) — lives under src/e2e/fixtures/. */
export function fixtureFileName(testCase: string, driver: string): string {
  return `${testCase}.${driver}.json`;
}

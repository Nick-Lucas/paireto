// Shared E2E-mode contract — the ONE place that names the mode env var, the harness-facing mock URL
// env var, and the per-driver fixture file name. Imported by BOTH the host runner (runE2E.ts /
// MockServerController) and the extension-host drivers, so it must stay dependency-light (env + string
// only — no node-only or vscode imports).
//
// Modes:
//   live   — today's behaviour: real harness talks straight to its real provider (needs creds).
//   record — harness talks to MockServer, which forwards to the real provider and captures the
//            traffic into a committable fixture (local-only; needs creds/upstream).
//   check  — harness talks to MockServer, which replays a committed fixture (NO creds, NO network).

export type E2EMode = "live" | "record" | "check";

/** Env var selecting the mode (unset/`live` = the classic real-provider path). */
export const MODE_ENV = "PAIRETO_E2E_MODE";
/** Env var carrying the MockServer URL the harness uses as its HTTP(S) PROXY (mock modes only). */
export const MOCK_URL_ENV = "PAIRETO_MOCK_URL";
/** Env var carrying the path to MockServer's CA cert (so the harness trusts the MITM proxy). */
export const MOCK_CA_ENV = "PAIRETO_MOCK_CA";
/** Env var naming the E2E test case being run (one case per run) — namespaces its fixture. */
export const CASE_ENV = "PAIRETO_E2E_CASE";

/** Parse the mode from an env bag (defaults to `live`); throws on an unknown value so a typo fails loud. */
export function resolveMode(env: NodeJS.ProcessEnv = process.env): E2EMode {
  const raw = (env[MODE_ENV] ?? "live").trim().toLowerCase();
  if (raw === "live" || raw === "record" || raw === "check") {
    return raw;
  }
  throw new Error(`${MODE_ENV}="${raw}" is invalid — use live|record|check`);
}

/** True for any mode that routes the harness through MockServer. */
export function isMockMode(mode: E2EMode): boolean {
  return mode !== "live";
}

/** The E2E test case being run (default `fullflow`); one case per run, namespacing its fixture. */
export function resolveCase(env: NodeJS.ProcessEnv = process.env): string {
  return (env[CASE_ENV] ?? "").trim() || "fullflow";
}

/** The committed fixture file name for a (case, driver) — lives under src/e2e/fixtures/. */
export function fixtureFileName(testCase: string, driver: string): string {
  return `${testCase}.${driver}.json`;
}

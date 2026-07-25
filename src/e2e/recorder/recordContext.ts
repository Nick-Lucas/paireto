// A process-local handle the RecordingDriver publishes so the real harness drivers (same extension-
// host process) can wire their sandbox at record-shims instead of the real scripts. Undefined outside
// a record run — a real driver is only ever constructed under the RecordingDriver, so it's always set
// by the time a driver's launch() reads it, but every reader guards for undefined anyway.

export interface RecordContext {
  /** The recorder service's unix socket the generated shims/wrapper dial. */
  socketPath: string;
  /** The extension dev repo root (where the REAL plugins/ live) — PAIRETO_REPO_ROOT. */
  repoRoot: string;
  /** A temp dir the RecordingDriver owns + cleans up; drivers stage record-only sandbox files here. */
  workDir: string;
  /** Generated hook shim (claude+codex): `node <hookShim> <repo-relative-script>`. */
  hookShim: string;
  /** Generated proc shim (claude MCP liveness): `node <procShim> <repo-relative-server>`. */
  procShim: string;
  /** Generated OpenCode wrapper plugin (imports the real paireto.js). */
  opencodeWrapper: string;
}

let active: RecordContext | undefined;

export function setRecordContext(ctx: RecordContext): void {
  active = ctx;
}

export function getRecordContext(): RecordContext | undefined {
  return active;
}

export function clearRecordContext(): void {
  active = undefined;
}

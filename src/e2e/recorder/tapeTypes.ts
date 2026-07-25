// The recorded-tape shape shared by record (write) and replay (read). The recorded boundary is
// HARNESS ↔ HOOKS: a tape is the ordered sequence of hook invocations (claude/codex) or plugin
// hook/tool calls (opencode) the REAL harness drove, captured verbatim (placeholder-normalized)
// with the extension + socket left entirely real. Replay re-drives the REAL plugin scripts /
// plugin against the REAL extension, emulating only the harness. See src/e2e/recordings/README.md.
// Serialized as canonical (recursively sorted-key) pretty JSON so tape diffs stay reviewable.

export interface Tape {
  test: "fullflow";
  /** "claudecode" | "codex" | "opencode". */
  harness: string;
  /** Informational — when the tape was recorded. */
  recordedAt: string;
  /** Actual PLUGIN_VERSION at record time (informational; wire versions are normalized to {{V}}). */
  pluginVersion: string;
  events: TapeEvent[];
}

export type TapeEvent =
  | HookStartEvent
  | HookEndEvent
  | ProcStartEvent
  | ProcStopEvent
  | PluginLoadEvent
  | PluginHookEvent
  | PluginToolStartEvent
  | PluginToolEndEvent
  | ClientCallEvent
  | DriverCallEvent
  | FsFinalEvent;

/** An event as the recorder appends it — the shared `seq` is assigned at append time, so callers pass
 *  everything but `seq`. Distributes over the union so each variant keeps its own discriminant keys. */
export type TapeEventInput = TapeEvent extends infer T
  ? T extends unknown
    ? Omit<T, "seq">
    : never
  : never;

// --- claude + codex: one hook invocation = a start/end pair --------------------------------------
// True interleaving is preserved (a blocking gate hook's end arrives after test actions; telemetry
// hooks start+end within it). `inv` correlates the pair; the recorder service assigns it on start.

export interface HookStartEvent {
  seq: number;
  k: "hook.start";
  inv: number;
  /** Repo-relative real script path, e.g. "plugins/codex/scripts/on-stop-gate.js". */
  script: string;
  /** Allowlisted, normalized env the shim observed. */
  env: Record<string, string>;
  cwd: string;
  /** Normalized raw stdin JSON (kept as a string for byte-fidelity replay). */
  stdin: string;
  /** Aux inputs materialized at replay (codex rollout transcript tail), keyed by {{FILE:n}}. */
  files?: Record<string, string>;
}

export interface HookEndEvent {
  seq: number;
  k: "hook.end";
  inv: number;
  stdout: string;
  exit: number;
  /** Working-tree delta captured when the invocation completed (omitted when empty). */
  fs?: FsDelta;
}

// --- long-lived harness-launched processes (claude mcp/server.js liveness) ------------------------

export interface ProcStartEvent {
  seq: number;
  k: "proc.start";
  proc: number;
  script: string;
  env: Record<string, string>;
  cwd: string;
}

export interface ProcStopEvent {
  seq: number;
  k: "proc.stop";
  proc: number;
}

// --- opencode: the plugin's harness-facing surface (paireto.js runs REAL in both modes) ----------

export interface PluginLoadEvent {
  seq: number;
  k: "plugin.load";
  /** The factory call input (client/$ are wrapped/stubbed). */
  input: { directory: string; worktree: string };
}

export interface PluginHookEvent {
  seq: number;
  k: "plugin.hook";
  inv: number;
  /** "event" | "config" | "experimental.chat.system.transform" | "tool.execute.before" | … */
  hook: string;
  /** Hook args at call time (before any in-place mutation). */
  input: unknown;
  /** Observable result / after-mutation snapshot, recorded at completion. */
  output?: unknown;
  fs?: FsDelta;
}

export interface PluginToolStartEvent {
  seq: number;
  k: "plugin.tool.start";
  inv: number;
  tool: string;
  args: unknown;
  ctx: { sessionID: string };
}

export interface PluginToolEndEvent {
  seq: number;
  k: "plugin.tool.end";
  inv: number;
  result: string;
  fs?: FsDelta;
}

export interface ClientCallEvent {
  seq: number;
  k: "client.call";
  /** plugin→opencode SDK call path: "session.prompt" | "app.agents" | "session.messages". */
  path: string;
  args: unknown;
  result: unknown;
}

// --- test-side checkpoints + final fs -------------------------------------------------------------

export interface DriverCallEvent {
  seq: number;
  k: "driver";
  method: "launch" | "enterPlanMode" | "prompt" | "afterPlanApprove";
  /** prompt() arg only. */
  text?: string;
}

export interface FsFinalEvent {
  seq: number;
  k: "fs.final";
  fs: FsDelta;
}

/** Repo-relative path → full utf8 content; null = deleted. `.git`/`.vscode` are excluded. */
export interface FsDelta {
  files: Record<string, string | null>;
}

export function isTape(value: unknown): value is Tape {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const t = value as Partial<Tape>;
  return t.test === "fullflow" && Array.isArray(t.events);
}

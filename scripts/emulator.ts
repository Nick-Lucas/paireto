#!/usr/bin/env node
"use strict";

// Paireto bridge emulator — a manual stand-in for Claude Code's hooks + MCP tool.
//
// It speaks the exact same wire protocol as the real plugin (it reuses bridge.js for socket
// resolution + handshake), so you can drive every VS Code flow — telemetry, the plan gate, the
// code-review round-trip — from a terminal WITHOUT a running agent, and watch the messages and
// responses pretty-printed.
//
//   node scripts/emulator.ts doctor            # resolve + handshake; is the extension listening?
//   node scripts/emulator.ts event <Name>      # fire one telemetry hook.event (fire-and-forget)
//   node scripts/emulator.ts plan [--file p]   # ExitPlanMode plan gate; blocks for Approve/Send Feedback
//   node scripts/emulator.ts review            # /paireto-review session; blocks for Send Feedback/Cancel
//   node scripts/emulator.ts flow              # simulate a whole agent session lifecycle
//   node scripts/emulator.ts help
//
// Runs directly on Node's TypeScript type-stripping (Node >= 22.18 / 23.6). CommonJS module:
// runtime values come in via require(); type-only imports are erased. Zero dependencies.
// Run it from inside the repo you've opened in VS Code (or pass --cwd / --socket).

import type { Socket } from "node:net";

const crypto = require("node:crypto") as typeof import("node:crypto");
const fs = require("node:fs") as typeof import("node:fs");

// ---------------------------------------------------------------------------
// Wire protocol (hand-mirrored from src/protocol/types.ts, like bridge.js)
// ---------------------------------------------------------------------------

type MessageType =
  | "hello"
  | "hello.ack"
  | "hook.event"
  | "plan.review.request"
  | "plan.review.response"
  | "review.await.request"
  | "review.await.response";

type HookEventName =
  | "SessionStart"
  | "SessionEnd"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "Stop"
  | "SubagentStart"
  | "SubagentStop"
  | "Notification"
  | "PermissionRequest"
  | "CwdChanged"
  | "FileChanged"
  | "WorktreeCreate"
  | "WorktreeRemove";

interface Envelope {
  t: MessageType;
  v: number;
  id?: string;
  ts: string;
}

interface HookEventMessage extends Envelope {
  t: "hook.event";
  event: HookEventName | string;
  sessionId: string;
  agentId?: string;
  agentType?: string;
  cwd: string;
  repoRoot: string;
  permissionMode?: string;
  toolName?: string;
  toolInput?: unknown;
  transcriptPath?: string;
}

interface PlanReviewRequest extends Envelope {
  t: "plan.review.request";
  id: string;
  sessionId: string;
  agentId?: string;
  cwd: string;
  repoRoot: string;
  permissionMode?: string;
  toolName: string;
  plan: string;
}

type PlanDecision = "allow" | "deny";

interface PlanReviewResponse extends Envelope {
  t: "plan.review.response";
  id: string;
  decision: PlanDecision;
  reason?: string;
}

interface ReviewAwaitRequest extends Envelope {
  t: "review.await.request";
  id: string;
  cwd: string;
  repoRoot: string;
  sessionId?: string;
}

type ReviewStatus = "submitted" | "cancelled";

interface ReviewAwaitResponse extends Envelope {
  t: "review.await.response";
  id: string;
  status: ReviewStatus;
  feedback: string;
}

// ---------------------------------------------------------------------------
// bridge.js — the plain-JS transport shared with the real hooks
// ---------------------------------------------------------------------------

interface Connection {
  sock: Socket;
  residual: string;
}

interface BridgeTarget {
  socketPath: string;
  repoRoot: string;
}

interface Bridge {
  PROTOCOL_VERSION: number;
  PLUGIN_VERSION: string;
  stateDir(): string;
  socketDir(): string;
  canonicalize(p: string): string;
  repoKey(toplevel: string): string;
  socketPathFor(toplevel: string): string;
  gitToplevel(cwd: string): string | null;
  resolveTarget(cwd: string): BridgeTarget | null;
  connectAndHandshake(socketPath: string, repoKeyHex: string, timeoutMs: number): Promise<Connection>;
  readMessages(sock: Socket, residual: string, onMessage: (msg: unknown) => void): void;
  sendLine(sock: Socket, obj: unknown): void;
  nowIso(): string;
}

const bridge = require("../plugins/claude-code/scripts/bridge.js") as Bridge;

// ---------------------------------------------------------------------------
// Pretty-printing
// ---------------------------------------------------------------------------

type Tint = (s: string | number) => string;

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const C = (code: string): Tint => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = C("1");
const dim = C("2");
const red = C("31");
const green = C("32");
const yellow = C("33");
const blue = C("34");
const magenta = C("35");
const cyan = C("36");

const ARROW_OUT = useColor ? cyan("→ SENT") : "→ SENT";
const ARROW_IN = useColor ? magenta("← RECV") : "← RECV";

function hr(ch?: string): string {
  return (ch || "─").repeat(Math.min(process.stdout.columns || 80, 80));
}

function heading(text: string): void {
  console.log("");
  console.log(bold(text));
  console.log(dim(hr()));
}

function field(label: string, value: string, color?: Tint): void {
  const tint: Tint = color || ((s) => String(s));
  console.log(`  ${dim(label.padEnd(14))} ${tint(value)}`);
}

// Colorize a JSON value for readable envelope dumps (keys, strings, numbers, keywords).
function prettyJson(obj: unknown): string {
  const raw = JSON.stringify(obj, null, 2);
  if (!useColor) {
    return raw;
  }
  return raw
    .replace(/"(\\.|[^"\\])*"(?=\s*:)/g, (m) => cyan(m)) // keys
    .replace(/: ("(\\.|[^"\\])*")/g, (_, s: string) => `: ${green(s)}`) // string values
    .replace(/: (-?\d+(?:\.\d+)?)/g, (_, n: string) => `: ${yellow(n)}`) // number values
    .replace(/: (true|false|null)/g, (_, k: string) => `: ${magenta(k)}`); // keywords
}

function dumpMessage(direction: string, obj: Envelope): void {
  console.log("");
  console.log(`${direction}  ${dim(obj.t || "?")}`);
  console.log(
    prettyJson(obj)
      .split("\n")
      .map((l) => "  " + l)
      .join("\n")
  );
}

function banner(text: string, color: Tint): void {
  const line = ` ${text} `;
  const pad = "═".repeat(line.length);
  console.log("");
  console.log(color(`╔${pad}╗`));
  console.log(color(`║${line}║`));
  console.log(color(`╚${pad}╝`));
}

function indent(text: string, prefix: string, color?: Tint): string {
  const tint: Tint = color || ((s) => String(s));
  return text
    .split("\n")
    .map((l) => tint(prefix) + l)
    .join("\n");
}

// ---------------------------------------------------------------------------
// CLI arg parsing (tiny)
// ---------------------------------------------------------------------------

type OptValue = string | boolean;
type Opts = Record<string, OptValue>;

interface ParsedArgs {
  positionals: string[];
  opts: Opts;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const opts: Opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        opts[key] = true;
      } else {
        opts[key] = next;
        i++;
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, opts };
}

/** Read an option as a string, or undefined when absent / a bare flag. */
function strOpt(opts: Opts, key: string): string | undefined {
  const v = opts[key];
  return typeof v === "string" ? v : undefined;
}

// ---------------------------------------------------------------------------
// Connection helpers
// ---------------------------------------------------------------------------

const DEFAULT_SESSION = "emu-" + crypto.randomUUID().slice(0, 8);
const CONNECT_TIMEOUT_MS = 3000;

interface Target {
  socketPath: string;
  repoRoot: string;
  cwd: string;
}

// Resolve the target socket the way the real hooks do, honouring --cwd / --socket overrides.
function resolveTarget(opts: Opts): Target | null {
  const cwdOpt = strOpt(opts, "cwd");
  const cwd = cwdOpt ? bridge.canonicalize(cwdOpt) : process.cwd();
  const socketOverride = strOpt(opts, "socket");
  if (socketOverride) {
    const repoRoot = bridge.gitToplevel(cwd) || cwd;
    return { socketPath: socketOverride, repoRoot: bridge.canonicalize(repoRoot), cwd };
  }
  const target = bridge.resolveTarget(cwd);
  if (!target) {
    return null;
  }
  return { socketPath: target.socketPath, repoRoot: target.repoRoot, cwd };
}

function connect(target: Target, timeoutMs: number): Promise<Connection> {
  const key = bridge.repoKey(target.repoRoot);
  return bridge.connectAndHandshake(target.socketPath, key, timeoutMs);
}

/** Build a telemetry hook.event for a session (so it shows up as a live agent in the panel). */
function telemetry(
  session: string,
  target: Target,
  event: HookEventName,
  tool?: string
): HookEventMessage {
  return {
    t: "hook.event",
    v: bridge.PROTOCOL_VERSION,
    ts: bridge.nowIso(),
    event,
    sessionId: session,
    cwd: target.cwd,
    repoRoot: target.repoRoot,
    toolName: tool,
    toolInput: tool ? defaultToolInput(tool) : undefined,
  };
}

/** Write one message on an existing connection (fire-and-forget). */
function writeOn(conn: Connection, msg: Envelope): Promise<void> {
  return new Promise((resolve) => conn.sock.write(JSON.stringify(msg) + "\n", () => resolve()));
}

interface LifecycleStep {
  event: HookEventName;
  tool?: string;
}

/** Emit the hook telemetry that makes a session appear as a connected, working agent. */
async function announceSession(
  conn: Connection,
  session: string,
  target: Target,
  events: LifecycleStep[]
): Promise<void> {
  for (const e of events) {
    await writeOn(conn, telemetry(session, target, e.event, e.tool));
  }
}

/** Send the held-open liveness attach so quitting the process drops the agent (mirrors the MCP server). */
function sendAttach(conn: Connection, session: string, target: Target): void {
  bridge.sendLine(conn.sock, {
    t: "session.attach",
    v: bridge.PROTOCOL_VERSION,
    ts: bridge.nowIso(),
    sessionId: session,
    repoRoot: target.repoRoot,
  });
}

interface BridgeContext {
  conn: Connection;
  target: Target;
  sessionId?: string;
}

interface CommandSpec {
  heading: string;
  /** Optional pre-connect diagnostics (used by `doctor`); receives the resolved target or null. */
  report?: (target: Target | null) => void;
  /** When set, the command represents a live agent: announce its session + hold a liveness attach. */
  live?: { sessionId: string; lifecycle: LifecycleStep[] };
}

/**
 * The golden path every command runs through: resolve the socket, run optional diagnostics, connect
 * + handshake, (optionally) announce a live session and hold a liveness attach, run the command body,
 * then tear the connection down. Centralises lifecycle + error handling so commands can't drift (it's
 * how `plan`/`review` previously forgot the liveness attach).
 */
async function withBridge(
  opts: Opts,
  spec: CommandSpec,
  body: (ctx: BridgeContext) => Promise<void>
): Promise<void> {
  const target = resolveTarget(opts);
  heading(spec.heading);
  spec.report?.(target);
  if (!target) {
    noTargetError(opts);
    return;
  }

  let conn: Connection;
  try {
    conn = await connect(target, CONNECT_TIMEOUT_MS);
  } catch (err) {
    banner("CONNECTION FAILED", red);
    field("error", errMessage(err), red);
    process.exitCode = 1;
    return;
  }

  try {
    if (spec.live) {
      await announceSession(conn, spec.live.sessionId, target, spec.live.lifecycle);
      sendAttach(conn, spec.live.sessionId, target);
    }
    await body({ conn, target, sessionId: spec.live?.sessionId });
  } finally {
    // Blocking bodies (plan/review) destroy the socket on response; agent never returns (held until
    // Ctrl+C). For everything else, close cleanly here.
    if (!conn.sock.destroyed) {
      conn.sock.end();
    }
  }
}

function noTargetError(opts: Opts): void {
  banner("NO BRIDGE FOUND", red);
  console.log("");
  console.log("  No VS Code Paireto socket resolved for this directory.");
  console.log("  Make sure the repo is open in VS Code with the extension active, then retry.");
  console.log("");
  const cwdOpt = strOpt(opts, "cwd");
  field("cwd", cwdOpt ? bridge.canonicalize(cwdOpt) : process.cwd());
  field("socket dir", bridge.socketDir());
  process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Shared response waiter
// ---------------------------------------------------------------------------

function awaitResponse<T extends Envelope>(
  conn: Connection,
  id: string,
  type: MessageType,
  timeoutMs: number
): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (val: T | null): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        conn.sock.destroy();
        resolve(val);
      }
    };
    const timer = setTimeout(() => {
      banner("TIMED OUT — no response", red);
      console.log(dim("  The hook would fall back to its configured fail mode here."));
      process.exitCode = 1;
      finish(null);
    }, timeoutMs);

    conn.sock.on("close", () => {
      if (!settled) {
        banner("CONNECTION CLOSED before a response", red);
        process.exitCode = 1;
        finish(null);
      }
    });

    bridge.readMessages(conn.sock, conn.residual, (msg: unknown) => {
      const m = msg as (Envelope & { __parseError?: boolean }) | null;
      if (m && m.__parseError) {
        banner("MALFORMED RESPONSE", red);
        process.exitCode = 1;
        finish(null);
        return;
      }
      if (m && m.t === type && m.id === id) {
        finish(m as unknown as T);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdDoctor(opts: Opts): Promise<void> {
  await withBridge(
    opts,
    {
      heading: "Doctor",
      report: (target) => {
        const cwdOpt = strOpt(opts, "cwd");
        const cwd = cwdOpt ? bridge.canonicalize(cwdOpt) : process.cwd();
        const top = bridge.gitToplevel(cwd);
        field("cwd", cwd);
        field("git toplevel", top || "(not a git repo)", top ? undefined : yellow);
        field("repo key", top ? bridge.repoKey(top) : "—");
        field("state dir", bridge.stateDir());
        if (target) {
          const exists = fs.existsSync(target.socketPath);
          field("socket path", target.socketPath);
          field("socket exists", exists ? "yes" : "no", exists ? green : red);
          field("repo root", target.repoRoot);
        }
      },
    },
    async () => {
      banner("CONNECTED", green);
      console.log("");
      console.log(dim("  The extension accepted the hook handshake. All flows are available."));
    }
  );
}

async function cmdEvent(opts: Opts, positionals: string[]): Promise<void> {
  const eventName = positionals[0] || "SessionStart";
  const tool = strOpt(opts, "tool");
  let toolInput: unknown;
  const inputJson = strOpt(opts, "input");
  if (inputJson !== undefined) {
    try {
      toolInput = JSON.parse(inputJson);
    } catch {
      console.log(red(`Invalid --input JSON: ${inputJson}`));
      process.exitCode = 1;
      return;
    }
  } else if (tool) {
    toolInput = defaultToolInput(tool);
  }

  // A raw one-off telemetry probe — no liveness attach (it isn't a held-open agent).
  await withBridge(opts, { heading: `Telemetry event · ${eventName}` }, async ({ conn, target }) => {
    const message: HookEventMessage = {
      t: "hook.event",
      v: bridge.PROTOCOL_VERSION,
      ts: bridge.nowIso(),
      event: eventName,
      sessionId: strOpt(opts, "session") || DEFAULT_SESSION,
      agentId: strOpt(opts, "agent"),
      agentType: strOpt(opts, "agent-type"),
      cwd: target.cwd,
      repoRoot: target.repoRoot,
      permissionMode: strOpt(opts, "mode"),
      toolName: tool,
      toolInput,
    };
    dumpMessage(ARROW_OUT, message);
    await writeOn(conn, message);
    console.log("");
    console.log(green("  ✓ sent (fire-and-forget — telemetry never gets a reply)"));
  });
}

async function cmdPlan(opts: Opts): Promise<void> {
  let plan = SAMPLE_PLAN;
  const file = strOpt(opts, "file");
  const inlinePlan = strOpt(opts, "plan");
  if (file) {
    plan = fs.readFileSync(file, "utf8");
  } else if (inlinePlan !== undefined) {
    plan = inlinePlan;
  }

  const timeoutMs = Number(strOpt(opts, "timeout") || 600) * 1000;
  const id = crypto.randomUUID();
  const sessionId = strOpt(opts, "session") || DEFAULT_SESSION;

  await withBridge(
    opts,
    {
      heading: "Plan gate · ExitPlanMode",
      live: {
        sessionId,
        lifecycle: [
          { event: "SessionStart" },
          { event: "UserPromptSubmit" },
          { event: "PreToolUse", tool: "ExitPlanMode" },
        ],
      },
    },
    async ({ conn, target }) => {
      const request: PlanReviewRequest = {
        t: "plan.review.request",
        v: bridge.PROTOCOL_VERSION,
        id,
        ts: bridge.nowIso(),
        sessionId,
        agentId: strOpt(opts, "agent"),
        cwd: target.cwd,
        repoRoot: target.repoRoot,
        permissionMode: strOpt(opts, "mode") || "plan",
        toolName: "ExitPlanMode",
        plan,
      };

      dumpMessage(ARROW_OUT, request);
      console.log("");
      console.log(
        yellow(`  ⏳ blocking — approve or send feedback in VS Code (timeout ${timeoutMs / 1000}s)…`)
      );

      const pending = awaitResponse<PlanReviewResponse>(conn, id, "plan.review.response", timeoutMs);
      bridge.sendLine(conn.sock, request);
      const response = await pending;
      if (!response) {
        return;
      }
      dumpMessage(ARROW_IN, response);

      if (response.decision === "allow") {
        banner("PLAN APPROVED — agent proceeds", green);
        console.log("");
        console.log(dim("  Hook would emit: PermissionRequest decision { behavior: 'allow' }"));
      } else {
        banner("CHANGES REQUESTED — agent revises", yellow);
        console.log("");
        console.log(bold("  Feedback returned to the agent (deny message):"));
        console.log("");
        console.log(indent(response.reason || "(none)", "  │ ", blue));
      }
    }
  );
}

async function cmdReview(opts: Opts): Promise<void> {
  const timeoutMs = Number(strOpt(opts, "timeout") || 600) * 1000;
  const id = crypto.randomUUID();
  const sessionId = strOpt(opts, "session") || DEFAULT_SESSION;

  await withBridge(
    opts,
    {
      heading: "Code review · paireto_review (MCP)",
      live: { sessionId, lifecycle: [{ event: "SessionStart" }, { event: "UserPromptSubmit" }] },
    },
    async ({ conn, target }) => {
      const request: ReviewAwaitRequest = {
        t: "review.await.request",
        v: bridge.PROTOCOL_VERSION,
        id,
        ts: bridge.nowIso(),
        cwd: target.cwd,
        repoRoot: target.repoRoot,
        sessionId,
      };

      dumpMessage(ARROW_OUT, request);
      console.log("");
      console.log(
        yellow(
          `  ⏳ blocking — review the diff in VS Code, then Send Feedback / Approve (timeout ${timeoutMs / 1000}s)…`
        )
      );

      const pending = awaitResponse<ReviewAwaitResponse>(
        conn,
        id,
        "review.await.response",
        timeoutMs
      );
      bridge.sendLine(conn.sock, request);
      const response = await pending;
      if (!response) {
        return;
      }
      dumpMessage(ARROW_IN, response);

      if (response.status === "submitted" && response.feedback) {
        banner("FEEDBACK SUBMITTED — agent acts on it", green);
        console.log("");
        console.log(bold("  Review comments returned as the tool result:"));
        console.log("");
        console.log(indent(response.feedback, "  │ ", blue));
      } else {
        banner("REVIEW APPROVED — agent proceeds, no changes", yellow);
      }
    }
  );
}

async function cmdFlow(opts: Opts): Promise<void> {
  const session = strOpt(opts, "session") || DEFAULT_SESSION;
  // A representative agent session lifecycle. (One connection here vs separate per-event hooks in
  // reality — equivalent to the extension, which keys sessions by id, not connection.) Ends with
  // SessionEnd, so no liveness attach.
  const steps: LifecycleStep[] = [
    { event: "SessionStart" },
    { event: "UserPromptSubmit" },
    { event: "PreToolUse", tool: "Read" },
    { event: "PostToolUse", tool: "Read" },
    { event: "PreToolUse", tool: "Edit" },
    { event: "PostToolUse", tool: "Edit" },
    { event: "Stop" },
    { event: "SessionEnd" },
  ];

  await withBridge(
    opts,
    { heading: `Simulated session lifecycle · ${session}` },
    async ({ conn, target }) => {
      for (const step of steps) {
        await writeOn(conn, telemetry(session, target, step.event, step.tool));
        const label = step.tool ? `${step.event} (${step.tool})` : step.event;
        console.log(`  ${green("✓")} ${label}`);
      }
      console.log("");
      console.log(dim("  Watch the Agents section + status bar in VS Code update as these arrive."));
    }
  );
}

async function cmdAgent(opts: Opts): Promise<void> {
  const session = strOpt(opts, "session") || DEFAULT_SESSION;
  await withBridge(
    opts,
    { heading: `Live agent session · ${session}`, live: { sessionId: session, lifecycle: [{ event: "SessionStart" }] } },
    async () => {
      banner("AGENT CONNECTED — holding session open", green);
      console.log("");
      console.log(dim("  Shows as a connected agent in VS Code. Ctrl+C to simulate killing the"));
      console.log(dim("  process — the extension should drop it from the Agents panel immediately."));
      console.log(dim(`  (Run \`plan\`/\`review --session ${session}\` from another terminal to gate it.)`));
      await new Promise<never>(() => {}); // hold open until Ctrl+C
    }
  );
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function defaultToolInput(tool: string): Record<string, unknown> {
  switch (tool) {
    case "Read":
      return { file_path: "src/extension.ts" };
    case "Edit":
      return { file_path: "src/extension.ts", old_string: "foo", new_string: "bar" };
    case "Write":
      return { file_path: "src/new-file.ts", content: "// ..." };
    case "Bash":
      return { command: "npm test", description: "Run tests" };
    case "ExitPlanMode":
      return { plan: SAMPLE_PLAN };
    default:
      return {};
  }
}

const SAMPLE_PLAN = `# Plan: Add retry to the bridge handshake

## Context
The hook handshake fails hard if the socket is momentarily busy during VS Code startup.

## Steps
1. Wrap \`connectAndHandshake\` in a bounded retry (3 attempts, 200ms backoff).
2. Add a unit test simulating a refused-then-accepted connection.
3. Surface retry exhaustion via the existing fail-mode config.

## Risks
- A slow extension could delay the agent by up to ~600ms before falling back.
`;

function errMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

// ---------------------------------------------------------------------------
// Help + dispatch
// ---------------------------------------------------------------------------

function usage(): void {
  console.log(`${bold("Paireto bridge emulator")}

Drives the VS Code extension's flows over the per-repo socket — no agent TUI needed.
Run from inside the repo you've opened in VS Code.

${bold("Commands")}
  ${cyan("doctor")}                  Resolve the socket and run the handshake. Start here.
  ${cyan("event")} <Name>           Send one telemetry hook.event (fire-and-forget).
                          Names: SessionStart UserPromptSubmit PreToolUse PostToolUse
                          Stop SubagentStart SubagentStop Notification SessionEnd …
  ${cyan("plan")}                    Send an ExitPlanMode plan gate; blocks for the decision.
  ${cyan("review")}                  Open a paireto_review session; blocks for Send Feedback / Cancel.
  ${cyan("flow")}                    Fire a full simulated session lifecycle of events.
  ${cyan("agent")}                   Hold a live session open (liveness connection). Ctrl+C to
                          simulate the agent process being killed → the extension drops it.
  ${cyan("help")}                    Show this.

${bold("Options")}
  --cwd <dir>             Resolve as if the agent ran here (default: process cwd).
  --socket <path>         Talk to this socket explicitly (skip resolution).
  --session <id>          Session id to report (default: ${DEFAULT_SESSION}).
  --tool <name>           Tool name for an event (Read/Edit/Write/Bash/…).
  --input <json>          Raw tool_input JSON for an event (overrides --tool default).
  --agent <id>            Subagent id.   --agent-type <type>   Subagent type.
  --mode <mode>           permissionMode (e.g. plan, acceptEdits).
  --plan <text>           Inline plan markdown for ${cyan("plan")}.
  --file <path>           Read plan markdown from a file for ${cyan("plan")}.
  --timeout <seconds>     Block timeout for plan/review (default 600).

${bold("Examples")}
  node emulator.ts doctor
  node emulator.ts event PreToolUse --tool Bash
  node emulator.ts plan --file ./my-plan.md
  node emulator.ts review
  node emulator.ts flow
`);
}

async function main(): Promise<void> {
  const { positionals, opts } = parseArgs(process.argv.slice(2));
  const cmd = positionals[0];
  const rest = positionals.slice(1);

  switch (cmd) {
    case undefined:
      usage();
      break;
    case "doctor":
      await cmdDoctor(opts);
      break;
    case "event":
      await cmdEvent(opts, rest);
      break;
    case "plan":
      await cmdPlan(opts);
      break;
    case "review":
      await cmdReview(opts);
      break;
    case "flow":
      await cmdFlow(opts);
      break;
    case "agent":
      await cmdAgent(opts);
      break;
    case "help":
    case "-h":
    case "--help":
      usage();
      break;
    default:
      console.log(red(`Unknown command: ${cmd}`));
      console.log(dim("Run `node emulator.ts help` for usage."));
      process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(red(`Emulator error: ${err instanceof Error ? err.stack || err.message : String(err)}`));
  process.exit(1);
});

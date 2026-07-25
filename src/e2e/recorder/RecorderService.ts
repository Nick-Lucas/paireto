// The record-side collector: a tiny unix-socket NDJSON server the generated shims + OpenCode wrapper
// dial. It centralizes the tape build — assigning the arrival-order `seq` (so concurrent hooks append
// deterministically), correlating each hook/tool start↔end via its connection's `inv`, and capturing
// the sandbox working-tree delta at every COMPLETION event (hook.end / plugin.hook / plugin.tool.end),
// exactly where the agent's own file writes have surfaced. Raw (un-normalized) events; normalization
// is a finalize step. Sealed before teardown so the dispose noise never enters the tape.

import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";

import { computeDelta, isEmptyDelta, snapshot } from "./snapshotFs.js";
import type { FsDelta, TapeEvent, TapeEventInput } from "./tapeTypes.js";

export interface RecorderServiceOptions {
  /** Short unix socket path to listen on (must stay under the ~104B sun_path limit). */
  socketPath: string;
  /** Sandbox repo root, snapshotted for the per-completion fs delta. */
  repoRoot: string;
}

/** Per-connection bookkeeping: the hook/tool `inv` this connection owns, and any proc it started. */
interface ConnState {
  buffer: string;
  inv?: number;
  proc?: number;
}

export class RecorderService {
  private server?: net.Server;
  private readonly sockets = new Set<net.Socket>();
  private readonly conns = new Map<net.Socket, ConnState>();
  private readonly events: TapeEvent[] = [];
  private seq = 0;
  private invCounter = 0;
  private procCounter = 0;
  private sealed = false;
  private lastRecordAt = Date.now();
  // Working-tree snapshot advanced on each completion event; baseline captured at start().
  private prevSnapshot = new Map<string, string>();

  constructor(private readonly opts: RecorderServiceOptions) {}

  /** ms since the last event was recorded — the RecordingDriver drains to quiescence before sealing
   *  so the OpenCode wrapper's serial fire-and-forget backlog (a streaming turn's ~100 events queued
   *  behind one socket) fully flushes; otherwise the trailing session.idle that opens the next gate is
   *  dropped and replay can't reproduce that turn. */
  msSinceLastEvent(): number {
    return Date.now() - this.lastRecordAt;
  }

  /** Bind the socket and take the baseline working-tree snapshot. */
  start(): Promise<void> {
    this.prevSnapshot = snapshot(this.opts.repoRoot);
    fs.mkdirSync(path.dirname(this.opts.socketPath), { recursive: true, mode: 0o700 });
    const server = net.createServer((socket) => this.onConnection(socket));
    this.server = server;
    return new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.opts.socketPath, () => {
        try {
          fs.chmodSync(this.opts.socketPath, 0o600);
        } catch {
          /* best effort */
        }
        resolve();
      });
    });
  }

  /** Stop appending — teardown noise (SessionEnd, liveness close) must not enter the tape. */
  seal(): void {
    this.sealed = true;
  }

  /** The delta from the last recorded completion snapshot to the current tree — the tape's fs.final. */
  finalDelta(): FsDelta {
    return computeDelta(this.prevSnapshot, snapshot(this.opts.repoRoot));
  }

  /** The captured tape events (raw, un-normalized). */
  captured(): TapeEvent[] {
    return this.events;
  }

  /** Append a driver checkpoint / fs.final from the RecordingDriver (assigns the shared seq). */
  append(event: TapeEventInput): void {
    this.record(event);
  }

  /** Close the listener and every live socket. */
  stop(): Promise<void> {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    const server = this.server;
    this.server = undefined;
    if (!server) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private onConnection(socket: net.Socket): void {
    this.sockets.add(socket);
    const state: ConnState = { buffer: "" };
    this.conns.set(socket, state);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      state.buffer += chunk;
      let nl: number;
      while ((nl = state.buffer.indexOf("\n")) !== -1) {
        const line = state.buffer.slice(0, nl);
        state.buffer = state.buffer.slice(nl + 1);
        this.handleLine(state, line);
      }
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      // A dropped proc-shim connection is the liveness process's death — record proc.stop.
      if (state.proc !== undefined) {
        this.record({ k: "proc.stop", proc: state.proc });
      }
      this.conns.delete(socket);
      this.sockets.delete(socket);
    });
  }

  /** Parse one NDJSON report and turn it into a tape event. */
  private handleLine(state: ConnState, line: string): void {
    if (line.trim() === "") {
      return;
    }
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // a garbled report is dropped rather than corrupting the tape.
    }
    switch (msg.report) {
      case "hook.start": {
        state.inv = ++this.invCounter;
        const event: TapeEventInput = {
          k: "hook.start",
          inv: state.inv,
          script: String(msg.script ?? ""),
          env: (msg.env ?? {}) as Record<string, string>,
          cwd: String(msg.cwd ?? ""),
          stdin: String(msg.stdin ?? ""),
        };
        if (msg.files && typeof msg.files === "object") {
          event.files = msg.files as Record<string, string>;
        }
        this.record(event);
        return;
      }
      case "hook.end":
        this.record({
          k: "hook.end",
          inv: state.inv ?? 0,
          stdout: String(msg.stdout ?? ""),
          exit: typeof msg.exit === "number" ? msg.exit : 0,
          ...this.deltaField(),
        });
        return;
      case "proc.start":
        state.proc = ++this.procCounter;
        this.record({
          k: "proc.start",
          proc: state.proc,
          script: String(msg.script ?? ""),
          env: (msg.env ?? {}) as Record<string, string>,
          cwd: String(msg.cwd ?? ""),
        });
        return;
      case "plugin.load":
        this.record({
          k: "plugin.load",
          input: (msg.input ?? { directory: "", worktree: "" }) as PluginLoadInput,
        });
        return;
      case "plugin.hook":
        this.record({
          k: "plugin.hook",
          inv: ++this.invCounter,
          hook: String(msg.hook ?? ""),
          input: msg.input,
          output: msg.output,
          ...this.deltaField(),
        });
        return;
      case "plugin.tool.start":
        state.inv = ++this.invCounter;
        this.record({
          k: "plugin.tool.start",
          inv: state.inv,
          tool: String(msg.tool ?? ""),
          args: msg.args,
          ctx: (msg.ctx ?? { sessionID: "" }) as { sessionID: string },
        });
        return;
      case "plugin.tool.end":
        this.record({
          k: "plugin.tool.end",
          inv: state.inv ?? 0,
          result: String(msg.result ?? ""),
          ...this.deltaField(),
        });
        return;
      case "client.call":
        this.record({
          k: "client.call",
          path: String(msg.path ?? ""),
          args: msg.args,
          result: msg.result,
        });
        return;
      default:
        return; // unknown report — ignore.
    }
  }

  /** Snapshot the repo, advance the baseline, and return an `fs` field (omitted when the delta empty). */
  private deltaField(): { fs?: FsDelta } {
    const next = snapshot(this.opts.repoRoot);
    const delta = computeDelta(this.prevSnapshot, next);
    this.prevSnapshot = next;
    return isEmptyDelta(delta) ? {} : { fs: delta };
  }

  private record(event: TapeEventInput): void {
    if (this.sealed) {
      return;
    }
    this.lastRecordAt = Date.now();
    this.events.push({ ...event, seq: this.seq++ } as TapeEvent);
  }
}

type PluginLoadInput = { directory: string; worktree: string };

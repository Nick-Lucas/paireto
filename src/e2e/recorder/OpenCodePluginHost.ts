// Replay emulator for the opencode harness: a strict sequential executor that runs the REAL plugin
// (plugins/opencode/paireto.js) in-process against the REAL extension, emulating only OpenCode's
// harness-facing surface from a tape.
//
//   plugin.load       → dynamic-import the real paireto.js and call its factory with a fake ctx
//                        ({directory,worktree} = sandbox repo, a tape-backed `client` stub, inert `$`).
//   plugin.hook       → invoke the real hook fn with the denormalized input; compare its observable
//                        result (mutation delta for config / system.transform / tool.definition; the
//                        return value otherwise) to the tape.
//   plugin.tool.start → invoke the registered tool's execute (a blocking gate) — do NOT await.
//   plugin.tool.end   → await it + compare the result string.
//   client.call       → NOT stepped: the plugin drives these reentrantly; the stub consumes them from
//                        a FIFO as they happen (asserting path + args, returning the recorded result).
//
// The plugin's OWN socket traffic (event forwards, liveness, gate round-trips) flows REAL — that's the
// point. A blocking custom tool's execute parks the loop at its plugin.tool.end while the test drives
// the gate through the extension.

import { pathToFileURL } from "node:url";
import * as path from "node:path";

import {
  compareMessages,
  denormalizeMessage,
  normalizeMessage,
  renderDivergence,
} from "./normalize.js";
import { TapeExecutor } from "./TapeExecutor.js";
import type {
  ClientCallEvent,
  PluginHookEvent,
  PluginLoadEvent,
  PluginToolEndEvent,
  PluginToolStartEvent,
  Tape,
  TapeEvent,
} from "./tapeTypes.js";
import type { Subst } from "./normalize.js";

/** The hooks the config + system-prompt hooks mutate their arguments in place (recorded as an
 *  arg-delta, not a return value) — mirrors the recorder's MUTATION_HOOKS set. */
const MUTATION_HOOKS = new Set(["config", "experimental.chat.system.transform", "tool.definition"]);

/** A minimal OpenCode plugin factory shape (only what the host invokes). */
interface OpenCodeHooks {
  [name: string]: unknown;
  tool?: Record<string, { execute: (args: unknown, ctx: unknown) => Promise<unknown> }>;
}
type Factory = (input: unknown) => Promise<OpenCodeHooks>;

/** Whether the extension currently has a review gate pending — injected by the ReplayDriver (it owns
 *  the vscode command surface). Lets the executor serialize the post-hoc review gates (see step). */
export type ReviewPendingProbe = () => Promise<boolean>;

export class OpenCodePluginHost extends TapeExecutor {
  private readonly repoRootAbs = requireEnv("PAIRETO_REPO_ROOT");
  /** Recorded client.call events queued PER PATH (session.prompt / session.messages / app.agents),
   *  consumed as the plugin calls each method. Per-path (not one global FIFO) because the OpenCode
   *  wrapper reports fire-and-forget over a serial socket, so cross-path ARRIVAL order in the tape is
   *  scrambled relative to real call order — but order WITHIN a path stays causal (each call site
   *  awaits its own reports). */
  private readonly clientQueues = new Map<string, ClientCallEvent[]>();
  /** Inflight/finished custom-tool executions by `inv`. */
  private readonly tools = new Map<number, Promise<unknown>>();
  private hooks?: OpenCodeHooks;

  constructor(
    tape: Tape,
    repoRoot: string,
    subst: Subst,
    private readonly reviewPending?: ReviewPendingProbe,
  ) {
    super(tape, repoRoot, subst);
    for (const e of tape.events) {
      if (e.k === "client.call") {
        const queue = this.clientQueues.get(e.path) ?? [];
        queue.push(e);
        this.clientQueues.set(e.path, queue);
      }
    }
  }

  protected async step(event: TapeEvent): Promise<void> {
    switch (event.k) {
      case "plugin.load":
        await this.load(event);
        return;
      case "plugin.hook":
        await this.runHook(event);
        return;
      case "plugin.tool.start":
        this.startTool(event);
        return;
      case "plugin.tool.end":
        await this.endTool(event);
        return;
      case "client.call":
        // Consumed reentrantly by the client stub — not stepped here.
        return;
      default:
        return;
    }
  }

  protected drainCheck(): string | undefined {
    for (const [path, queue] of this.clientQueues) {
      if (queue.length > 0) {
        return `replay left ${queue.length} unconsumed client.call event(s) for ${path}`;
      }
    }
    return undefined;
  }

  protected teardown(): void {
    // The plugin's held liveness sockets close with the extension-host process after assertions; there
    // is nothing to tear down in-process (no child procs). The event loop's own handles suffice.
  }

  protected status(): string {
    const inflight = [...this.tools.keys()];
    const tail = inflight.length > 0 ? `tools inflight: ${inflight.join(",")}` : "";
    const remaining = [...this.clientQueues].reduce((n, [, q]) => n + q.length, 0);
    const q = `client queue: ${remaining}`;
    return tail ? `${tail}; ${q}` : q;
  }

  // --- plugin lifecycle --------------------------------------------------------------------------

  private async load(event: PluginLoadEvent): Promise<void> {
    this.blockedOn = "plugin.load (factory)";
    const modUrl = pathToFileURL(path.join(this.repoRootAbs, "plugins", "opencode", "paireto.js"));
    const mod = (await import(modUrl.href)) as { PairetoOpenCode: Factory };
    const input = denormalizeMessage(event.input, this.subst) as {
      directory: string;
      worktree: string;
    };
    this.hooks = await mod.PairetoOpenCode({
      directory: input.directory,
      worktree: input.worktree,
      client: this.makeClient(),
      // OpenCode's shell-template tag; unused by this plugin — an inert stub keeps the ctx complete.
      $: () => undefined,
    });
  }

  private async runHook(event: PluginHookEvent): Promise<void> {
    this.blockedOn = `plugin.hook ${event.hook}`;
    const fn = this.hooks?.[event.hook];
    if (typeof fn !== "function") {
      this.fail(
        `plugin.hook ${event.hook} (seq ${event.seq}) — no such hook returned by the factory`,
      );
      return;
    }
    const args = denormalizeMessage(event.input, this.subst) as unknown[];
    const ret = await (fn as (...a: unknown[]) => Promise<unknown>)(...args);
    if (this.failure) {
      return;
    }
    const expected = event.output ?? {};
    const actual = MUTATION_HOOKS.has(event.hook) ? { args, ret } : { ret };
    const diff = this.compareValue(`plugin.hook ${event.hook}`, event.seq, expected, actual);
    if (diff) {
      this.fail(diff);
      return;
    }
    if (event.fs) {
      this.applyFs(event.fs);
    }
    // A session.idle event hook fires the plugin's post-hoc turn-end gate (void-dispatched). Because
    // replay races through the tape with no LLM latency, without this park BOTH idles would fire their
    // gates near-simultaneously and the second would hit the extension's busy review slot (allowed → no
    // gate). Park until the gate this idle opened resolves, reproducing the real-time separation.
    if (isSessionIdle(event.hook, args)) {
      await this.settleReviewGate();
    }
  }

  /** After a session.idle event hook: wait briefly for the post-hoc review gate to appear (the
   *  blockingRequest is async), then — if it did — until the test resolves it. No probe / no gate → a
   *  bounded no-op. */
  private async settleReviewGate(): Promise<void> {
    if (!this.reviewPending) {
      return;
    }
    const APPEAR_MS = 4000;
    const RESOLVE_BUDGET_MS = 60_000;
    this.blockedOn = "post-hoc review gate (awaiting open)";
    const appearBy = Date.now() + APPEAR_MS;
    while (Date.now() < appearBy) {
      if (await this.reviewPending()) {
        break;
      }
      await delay(150);
    }
    if (!(await this.reviewPending())) {
      return; // this idle opened no review gate (allow) — proceed.
    }
    this.blockedOn = "post-hoc review gate (awaiting resolve)";
    const resolveBy = Date.now() + RESOLVE_BUDGET_MS;
    while (Date.now() < resolveBy) {
      if (!(await this.reviewPending())) {
        return;
      }
      await delay(150);
    }
  }

  private startTool(event: PluginToolStartEvent): void {
    this.blockedOn = `plugin.tool.start ${event.tool} inv ${event.inv}`;
    const tool = this.hooks?.tool?.[event.tool];
    if (!tool || typeof tool.execute !== "function") {
      this.fail(`plugin.tool.start ${event.tool} (seq ${event.seq}) — tool not registered`);
      this.tools.set(event.inv, Promise.resolve(""));
      return;
    }
    const args = denormalizeMessage(event.args, this.subst);
    const ctx = denormalizeMessage(event.ctx, this.subst);
    this.tools.set(event.inv, tool.execute(args, ctx));
  }

  private async endTool(event: PluginToolEndEvent): Promise<void> {
    const pending = this.tools.get(event.inv);
    if (!pending) {
      this.fail(`plugin.tool.end for inv ${event.inv} but no matching start (seq ${event.seq})`);
      return;
    }
    this.blockedOn = `plugin.tool.end inv ${event.inv}`;
    const result = await pending;
    if (this.failure) {
      return;
    }
    const text = typeof result === "string" ? result : String(result);
    const diff = this.compareValue(
      `plugin.tool.end inv ${event.inv}`,
      event.seq,
      event.result,
      text,
    );
    if (diff) {
      this.fail(diff);
    } else if (event.fs) {
      this.applyFs(event.fs);
    }
  }

  // --- the tape-backed client stub ---------------------------------------------------------------

  /** A client whose SDK methods consume the client.call FIFO: assert path + args, return the recorded
   *  result. The plugin swallows errors (fail-open), so a mismatch is recorded via fail() (first
   *  divergence wins) and the recorded result is still returned to avoid a confusing cascade. */
  private makeClient(): unknown {
    const call = (p: string, args: unknown): unknown => this.clientCall(p, args);
    return {
      app: { agents: (args: unknown) => Promise.resolve(call("app.agents", args)) },
      session: {
        prompt: (args: unknown) => Promise.resolve(call("session.prompt", args)),
        messages: (args: unknown) => Promise.resolve(call("session.messages", args)),
      },
    };
  }

  private clientCall(p: string, args: unknown): unknown {
    const event = this.clientQueues.get(p)?.shift();
    if (!event) {
      this.fail(`unexpected client call ${p} — the tape has no more ${p} client.call events`);
      return { data: [] };
    }
    const diff = this.compareValue(`client.call ${p} args`, event.seq, event.args, args);
    if (diff) {
      this.fail(diff);
    }
    return denormalizeMessage(event.result, this.subst);
  }

  // --- comparison --------------------------------------------------------------------------------

  /** Compare an expected (tape, already normalized) value against a normalized actual one. Returns a
   *  readable divergence report, or null when equal. */
  private compareValue(
    label: string,
    seq: number,
    expectedNorm: unknown,
    actualRaw: unknown,
  ): string | null {
    const actualNorm = normalizeMessage(actualRaw, "in", this.subst);
    const diff = compareMessages(expectedNorm, actualNorm);
    if (diff.equal) {
      return null;
    }
    return renderDivergence({
      seq,
      conn: 0,
      type: label,
      expected: expectedNorm,
      actual: actualNorm,
      paths: diff.paths,
    });
  }
}

/** Whether an `event` hook invocation is a session.idle (the args are `[{ event: { type } }]`). */
function isSessionIdle(hook: string, args: unknown[]): boolean {
  if (hook !== "event") {
    return false;
  }
  const first = args[0];
  if (typeof first !== "object" || first === null) {
    return false;
  }
  const ev = (first as { event?: { type?: unknown } }).event;
  return !!ev && ev.type === "session.idle";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing required env ${name}`);
  }
  return value;
}

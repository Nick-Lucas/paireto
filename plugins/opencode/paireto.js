// Paireto OpenCode adapter — a single self-contained ES-module plugin. OpenCode autoloads global +
// project plugins LAZILY (on the first session op, not server boot — see the empirical notes), runs
// them in-process under Bun, and exposes an `event` hook, awaited `tool.execute.before/after` hooks,
// and custom `tool` registrations whose `execute()` can BLOCK the agent by returning a Promise<string>.
//
// This module bridges those into the same per-repo Unix socket the Claude/Codex adapters use:
//   - It gates on a real git worktree (OpenCode reports worktree "/" in a non-git dir → no-op).
//   - The per-repo socket path is derived from the canonicalized worktree, BYTE-IDENTICAL to
//     src/protocol/paths.ts (realpath both sides before hashing, or the hook talks to the wrong socket).
//   - `event` forwards session/permission/file/message events fire-and-forget over ONE lazily-(re)opened
//     connection, writes serialized so they can't interleave, each stamped with the owning sessionID and
//     (for a known child session) a parentSessionID — the ONE piece of cross-event correlation that has
//     to live plugin-side (the extension's mapper is stateless per the seam invariant).
//   - `tool.execute.before/after` are forwarded as synthetic events and RETURN IMMEDIATELY (they're
//     awaited hooks — blocking here would stall every tool call).
//   - Per top-level session it holds a dedicated `session.attach` liveness connection open; the OS
//     dropping it on process death is how the extension clears the row (verified: process kill drops
//     held sockets instantly). Closed on session.deleted / server.instance.disposed.
//   - `paireto_review` / `paireto_submit_plan` custom tools open their OWN blocking round-trip
//     connections (analogous to the Claude MCP `paireto_review` tool).
//
// Fail-open everywhere: no socket / connect failure / bad ack → the hook or tool silently degrades
// (events drop, gates return "proceed") rather than ever stalling or crashing the agent.

import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

// Single source of truth for every version this adapter reports (wire `v`, hello `pluginVersion`),
// read straight from the adapter manifest — the version-lockstep test asserts it === PLUGIN_VERSION.
// Read via fs (not a JSON import) so it works identically under Bun and plain node ESM.
const PLUGIN_VERSION = JSON.parse(
  fs.readFileSync(new URL("./adapter.json", import.meta.url), "utf8"),
).version;

const APP_DIR = "paireto";
const HANDSHAKE_TIMEOUT_MS = 3000;
// Max time a blocking custom-tool gate waits for a decision before failing open (~4 days) — matches
// the Codex plan gate. The agent stays parked in the tool call until the user acts or the socket drops.
const GATE_TIMEOUT_MS = 345600 * 1000;

// The tool the planning workflow steers the agent onto, and the agents allowed to call it. OpenCode
// has no ExitPlanMode gate to intercept (session.idle is fire-and-forget), so instead of hoping the
// user instructs their agent, the plugin instructs the agent itself — the config hook scopes the tool
// to planning agents and the system-prompt transform tells a planning session to submit its plan via
// the tool. Zero user setup. Default planning agent = OpenCode's built-in `plan`.
const SUBMIT_PLAN_TOOL = "paireto_submit_plan";
const PLANNING_AGENTS = ["plan"];

// LEAN planning instruction appended to a planning session's system prompt (see design A.2 — the WHY
// is deliberately terse; the model is capable, the tool description carries the mechanics).
const PLANNING_PROMPT = `## Paireto — Plan Review

You have a \`${SUBMIT_PLAN_TOOL}\` tool. When your plan is complete, call it with the full plan as
markdown (the \`plan\` argument) to open it for review in the user's connected VS Code window. The
call blocks until the user approves or requests changes; on changes, revise and submit again.

- Do NOT end your turn without either submitting a plan via \`${SUBMIT_PLAN_TOOL}\` or asking the
  user a question.
- Do NOT begin implementation until your plan is approved.`;

// ---------------------------------------------------------------------------
// Automation policy — PURE, EXPORTED FOR UNIT TESTS. No IO, no OpenCode client; every runtime hook
// below resolves its inputs (config object, resolved agent, gate response) then defers the decision
// here so it can be exercised without a live OpenCode host.
// ---------------------------------------------------------------------------

/** Dedup a raw `experimental.primary_tools` value into a clean string array (drops non-strings /
 *  blanks / duplicates). Anything not an array reads as empty — we only ever ADD our tool. */
function normalizePrimaryTools(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set();
  const out = [];
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/** The agent's `permission` map, coerced to a plain object. SPREAD HAZARD: OpenCode permission values
 *  can be a bare string (`"allow"`) as well as an object; a malformed/absent `permission` must not be
 *  spread (spreading a string yields `{0:"a",1:"l",…}`). We reset only when it isn't a usable object,
 *  then MUTATE IN PLACE (never spread) so existing per-tool entries survive untouched. */
function ensurePermission(agent) {
  if (!agent.permission || typeof agent.permission !== "object" || Array.isArray(agent.permission)) {
    agent.permission = {};
  }
  return agent.permission;
}

/** A non-planning agent that CAN run the plan tool if we don't deny it — anything not a subagent
 *  (primary / all / unset mode). Subagents never see the tool (it's in primary_tools). */
function isPrimaryCapableAgent(agent) {
  const mode = agent && typeof agent.mode === "string" ? agent.mode : undefined;
  return mode !== "subagent";
}

/**
 * Mutate an OpenCode config object so ONLY the planning agents can call the plan tool (mirrors
 * plannotator's applyWorkflowConfig, simplified — we never touch `edit` perms, so there's no
 * edit-string-vs-object normalization). Idempotent. Steps:
 *   - add the tool to `experimental.primary_tools` (hides it from every subagent),
 *   - `permission.<tool> = "allow"` for each planning agent (creating the agent entry if absent),
 *   - `permission.<tool> = "deny"` for the built-in `build` agent and every other primary-capable
 *     agent already declared in the config.
 */
function applyOpenCodeConfig(config, planningAgents) {
  const existing = normalizePrimaryTools(config.experimental?.primary_tools);
  config.experimental = {
    ...config.experimental,
    primary_tools: existing.includes(SUBMIT_PLAN_TOOL)
      ? existing
      : [...existing, SUBMIT_PLAN_TOOL],
  };

  if (!config.agent || typeof config.agent !== "object" || Array.isArray(config.agent)) {
    config.agent = {};
  }
  const planningSet = new Set(planningAgents);

  for (const name of planningAgents) {
    config.agent[name] ??= {};
    ensurePermission(config.agent[name])[SUBMIT_PLAN_TOOL] = "allow";
  }

  // `build` is OpenCode's built-in primary agent; deny it explicitly even when the user hasn't
  // declared it in config.agent (it exists implicitly).
  if (!planningSet.has("build")) {
    config.agent["build"] ??= {};
    ensurePermission(config.agent["build"])[SUBMIT_PLAN_TOOL] = "deny";
  }

  for (const [name, agent] of Object.entries(config.agent)) {
    if (planningSet.has(name)) {
      continue;
    }
    if (agent && typeof agent === "object" && !Array.isArray(agent) && isPrimaryCapableAgent(agent)) {
      ensurePermission(agent)[SUBMIT_PLAN_TOOL] = "deny";
    }
  }
}

/** True for the internal title-generation prompt (a short LLM call OpenCode makes with no real agent
 *  session) — we must never inject planning steering into it. Matches plannotator's substring check. */
function isTitleGeneratorPrompt(systemText) {
  const lower = (systemText || "").toLowerCase();
  return lower.includes("title generator") || lower.includes("generate a title");
}

/** The agent name of the LAST user message (that's the agent driving the current turn), or undefined.
 *  Messages come from `client.session.messages` as `{ info, parts }[]`. Mirrors plannotator. */
function getLastUserAgentFromMessages(messages) {
  if (!Array.isArray(messages)) {
    return undefined;
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messages[i] && messages[i].info;
    if (info && info.role === "user" && typeof info.agent === "string") {
      return info.agent;
    }
  }
  return undefined;
}

/** The declared `mode` of a named agent from the cached `app.agents` list, or undefined if unknown. */
function agentModeFor(agentName, agents) {
  const list = Array.isArray(agents) ? agents : [];
  const agent = list.find((a) => a && a.name === agentName);
  return agent && typeof agent.mode === "string" ? agent.mode : undefined;
}

/** Whether to append the planning steering to this session's system prompt. Only a resolved,
 *  non-subagent PLANNING agent qualifies, and never the title-generator prompt. */
function shouldInjectPlanningPrompt({ agentName, isSubagent, isTitleGenerator, planningAgents }) {
  if (isTitleGenerator || isSubagent || !agentName) {
    return false;
  }
  return planningAgents.includes(agentName);
}

/** True when this session id is a KNOWN child (sub-)session — used to fire the post-hoc turn-end gate
 *  only for TOP-LEVEL sessions (a child's idle is a subagent finishing, not the user's turn ending). */
function isChildSession(sessionID, parentOf) {
  return !!sessionID && !!parentOf && parentOf.has(sessionID);
}

/** Map a stop.gate.response to the feedback to inject as a new user turn, or null to inject NOTHING.
 *  STRICT: only an explicit `block` with a non-empty reason injects — allow, a blank reason, the
 *  fail-open fallback (null), or any malformed message all resolve to "do nothing". */
function stopGateInjectionReason(msg) {
  if (msg && msg.decision === "block" && typeof msg.reason === "string" && msg.reason.trim()) {
    return msg.reason;
  }
  return null;
}

/** Build the `args` (ZodRawShape) for the paireto_submit_plan tool from OpenCode's zod instance
 *  (`tool.schema`, resolved at runtime — the plugin imports only node builtins at top level).
 *  OpenCode types tool `args` as a RECORD OF ZOD SCHEMAS: a bare value (e.g. `""`) is NOT a valid
 *  entry — it throws during JSON-schema advertisement and arg validation, so the plan text would
 *  never reach VS Code. When the SDK zod is unavailable (i.e. not running under OpenCode — unit
 *  tests) fall back to an empty shape (fail-open; the tool advertises no args instead of crashing). */
function planToolArgs(schema) {
  if (!schema || typeof schema.string !== "function") {
    return {};
  }
  return { plan: schema.string().describe("The full implementation plan, as markdown.") };
}

// ---------------------------------------------------------------------------
// Paths + key (byte-identical mirror of src/protocol/paths.ts)
// ---------------------------------------------------------------------------

function stateDir() {
  const xdg = process.env.XDG_STATE_HOME;
  const base = xdg && xdg.trim() !== "" ? xdg : path.join(os.homedir(), ".local", "state");
  return path.join(base, APP_DIR);
}

function socketDir() {
  return path.join(stateDir(), "s");
}

function canonicalize(p) {
  let resolved;
  try {
    resolved = fs.realpathSync(p);
  } catch {
    resolved = path.resolve(p);
  }
  if (resolved.length > 1 && resolved.endsWith(path.sep)) {
    resolved = resolved.slice(0, -1);
  }
  return resolved;
}

function repoKey(toplevel) {
  const canonical = canonicalize(toplevel);
  const digest = crypto.createHash("sha256").update(canonical, "utf8").digest();
  return digest.subarray(0, 8).toString("hex");
}

function socketPathFor(toplevel) {
  return path.join(socketDir(), `${repoKey(toplevel)}.sock`);
}

function nowIso() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// NDJSON socket transport (mirror of the Claude/Codex bridge.js handshake)
// ---------------------------------------------------------------------------

/** Open a connection and complete the hello/hello.ack handshake. Resolves with the live socket (+ any
 *  residual buffered bytes) or null on missing socket / timeout / refused / rejected — never rejects,
 *  so every caller can treat null as "no window, fail open". */
function connectAndHandshake(socketPath, repoKeyHex) {
  return new Promise((resolve) => {
    if (!fs.existsSync(socketPath)) {
      resolve(null);
      return;
    }
    const sock = net.createConnection(socketPath);
    let buffer = "";
    let settled = false;

    const done = (value) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }
    };
    const fail = () => {
      sock.destroy();
      done(null);
    };
    const timer = setTimeout(fail, HANDSHAKE_TIMEOUT_MS);

    sock.setEncoding("utf8");
    sock.on("error", fail);
    sock.on("connect", () => {
      sock.write(
        JSON.stringify({
          t: "hello",
          v: PLUGIN_VERSION,
          ts: nowIso(),
          role: "hook",
          pluginVersion: PLUGIN_VERSION,
          repoKey: repoKeyHex,
        }) + "\n",
      );
    });
    sock.on("data", (chunk) => {
      buffer += chunk;
      const idx = buffer.indexOf("\n");
      if (idx === -1) {
        return;
      }
      const line = buffer.slice(0, idx);
      const residual = buffer.slice(idx + 1);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        fail();
        return;
      }
      if (msg && msg.t === "hello.ack" && msg.accept) {
        done({ sock, residual });
      } else {
        fail();
      }
    });
  });
}

/** Read NDJSON lines from a socket, invoking onMessage for each parsed object. */
function readMessages(sock, residual, onMessage) {
  let buffer = residual || "";
  const flush = () => {
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.trim() === "") {
        continue;
      }
      try {
        onMessage(JSON.parse(line));
      } catch {
        // ignore malformed line — fail open
      }
    }
  };
  flush();
  sock.on("data", (chunk) => {
    buffer += chunk;
    flush();
  });
}

// ---------------------------------------------------------------------------
// Event-shape plumbing (owning sessionID + child parentID extraction)
// ---------------------------------------------------------------------------

/** The owning session id for a raw SDK event, per type. session.* carry it on `properties.info.id`;
 *  permission.* on `properties.sessionID`; message.updated on `properties.info.sessionID`. Returns
 *  undefined when it can't be resolved (that event is then dropped — can't attribute it to a row). */
function owningSessionId(event) {
  const props = event.properties || {};
  const info = props.info || {};
  if (typeof info.sessionID === "string") {
    return info.sessionID; // message.updated (Message.sessionID)
  }
  if (typeof info.id === "string") {
    return info.id; // session.* (Session.id)
  }
  if (typeof props.sessionID === "string") {
    return props.sessionID; // permission.* / file.edited
  }
  return undefined;
}

/** Build the curated properties the extension's OpenCodeStrategy reads — plumbing only, never
 *  semantic mapping (that's the strategy's job). Always stamps `sessionID`; carries `info` (id +
 *  parentID) for session events, `role` for messages, `file` for file.edited. */
function curatedProperties(event, sessionID) {
  const props = event.properties || {};
  const info = props.info || {};
  const out = { sessionID };
  if (typeof info.id === "string") {
    out.info = { id: info.id };
    if (typeof info.parentID === "string") {
      out.info.parentID = info.parentID;
    }
  }
  if (typeof info.role === "string") {
    out.role = info.role;
  }
  if (typeof props.file === "string") {
    out.file = props.file;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The per-worktree bridge (one event connection + liveness connections + gate round-trips)
// ---------------------------------------------------------------------------

function createBridge(worktree) {
  const repoRoot = canonicalize(worktree);
  const repoKeyHex = repoKey(repoRoot);
  const socketPath = socketPathFor(repoRoot);

  // sessionID → parentID for child (sub-)sessions, learned from session.created/updated. The ONE bit
  // of cross-event correlation the extension can't do statelessly — enriches every forwarded child
  // event with parentSessionID so it routes to the parent row (see OpenCodeStrategy).
  const parentOf = new Map();
  // Held-open liveness connections keyed by top-level sessionID (their close = that agent died).
  const livenessSockets = new Map();

  // The single fire-and-forget event connection, lazily (re)opened. `sendChain` serializes writes so
  // a connect + queued writes stay ordered even when several events fire in the same tick.
  let eventSock = null;
  let sendChain = Promise.resolve();

  async function eventConnection() {
    if (eventSock && !eventSock.destroyed) {
      return eventSock;
    }
    const conn = await connectAndHandshake(socketPath, repoKeyHex);
    if (!conn) {
      return null; // no window listening — caller drops the event
    }
    eventSock = conn.sock;
    // Drain anything the extension sends on this connection (it won't) so the buffer never grows;
    // null out on close so the next forward lazily reconnects.
    conn.sock.on("error", () => {});
    conn.sock.on("close", () => {
      if (eventSock === conn.sock) {
        eventSock = null;
      }
    });
    return eventSock;
  }

  /** Forward one envelope fire-and-forget over the (lazily reconnected) event connection. Serialized
   *  and swallow-all — telemetry must never throw into a hook. */
  function forward(message) {
    sendChain = sendChain
      .then(async () => {
        const sock = await eventConnection();
        if (!sock) {
          return;
        }
        await new Promise((resolve) => {
          sock.write(JSON.stringify(message) + "\n", () => resolve());
        });
      })
      .catch(() => {});
  }

  /** Forward a raw/synthetic SDK event as a hook.event, stamping the owning sessionID + (for a known
   *  child) parentSessionID. Events whose session can't be resolved are dropped. */
  function forwardEvent(type, event) {
    const sessionID = owningSessionId(event);
    if (!sessionID) {
      return;
    }
    const forwarded = { type, properties: curatedProperties(event, sessionID) };
    const parentID = parentOf.get(sessionID);
    if (parentID) {
      forwarded.parentSessionID = parentID;
    }
    forward({
      t: "hook.event",
      v: PLUGIN_VERSION,
      ts: nowIso(),
      harness: "opencode",
      repoRoot,
      event: forwarded,
    });
  }

  /** Forward a synthetic tool.execute.before/after event (awaited hooks aren't on the event bus).
   *  Returns immediately — never awaits the forward. */
  function forwardTool(type, input) {
    const sessionID = input && input.sessionID;
    if (typeof sessionID !== "string") {
      return;
    }
    const forwarded = {
      type,
      properties: { sessionID, tool: input.tool, callID: input.callID },
    };
    const parentID = parentOf.get(sessionID);
    if (parentID) {
      forwarded.parentSessionID = parentID;
    }
    forward({
      t: "hook.event",
      v: PLUGIN_VERSION,
      ts: nowIso(),
      harness: "opencode",
      repoRoot,
      event: forwarded,
    });
  }

  // ---- liveness ----------------------------------------------------------

  /** Hold a dedicated connection open for a top-level session; its eventual close (process death) is
   *  the extension's remove-the-row signal. Best-effort — no window → nothing to hold. */
  function attachLiveness(sessionID) {
    if (livenessSockets.has(sessionID)) {
      return;
    }
    // Reserve the slot synchronously so a burst of session.created can't open duplicates.
    livenessSockets.set(sessionID, null);
    connectAndHandshake(socketPath, repoKeyHex)
      .then((conn) => {
        if (!conn) {
          livenessSockets.delete(sessionID);
          return;
        }
        // detachLiveness may have run while we were connecting (a short-lived session created then
        // deleted). The reserved slot is `null` only while still wanted; anything else (deleted, or
        // a newer attach) means abandon this socket rather than resurrect a gone session's row.
        if (livenessSockets.get(sessionID) !== null) {
          conn.sock.destroy();
          return;
        }
        conn.sock.on("error", () => {});
        livenessSockets.set(sessionID, conn.sock);
        conn.sock.on("close", () => {
          if (livenessSockets.get(sessionID) === conn.sock) {
            livenessSockets.delete(sessionID);
          }
        });
        // Key MUST be `sessionId` — the extension's SocketServer reads `msg.sessionId` (the wire
        // SessionAttachMessage), so a shorthand `sessionID` would attach `undefined` and never detach.
        conn.sock.write(
          JSON.stringify({
            t: "session.attach",
            v: PLUGIN_VERSION,
            ts: nowIso(),
            sessionId: sessionID,
            repoRoot,
          }) + "\n",
        );
      })
      .catch(() => livenessSockets.delete(sessionID));
  }

  function detachLiveness(sessionID) {
    const sock = livenessSockets.get(sessionID);
    livenessSockets.delete(sessionID);
    if (sock) {
      sock.destroy();
    }
  }

  function closeAll() {
    for (const sessionID of [...livenessSockets.keys()]) {
      detachLiveness(sessionID);
    }
    if (eventSock) {
      eventSock.destroy();
      eventSock = null;
    }
  }

  // ---- blocking gate round-trip (custom tools) ---------------------------

  /**
   * Open a fresh connection, send `request`, and block until a `responseType` message with a matching
   * id arrives — then resolve via `onResponse(msg)`. Fails open (`fallback`) on no window / connect
   * failure / dropped socket / timeout. Mirrors the Claude MCP server's blocking review round-trip.
   */
  async function blockingRequest(buildRequest, responseType, onResponse, fallback) {
    const conn = await connectAndHandshake(socketPath, repoKeyHex);
    if (!conn) {
      return fallback;
    }
    const id = crypto.randomUUID();
    return await new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          conn.sock.destroy();
          resolve(value);
        }
      };
      const timer = setTimeout(() => finish(fallback), GATE_TIMEOUT_MS);
      conn.sock.on("error", () => finish(fallback));
      conn.sock.on("close", () => finish(fallback));
      readMessages(conn.sock, conn.residual, (msg) => {
        if (msg && msg.t === responseType && msg.id === id) {
          finish(onResponse(msg));
        }
      });
      conn.sock.write(JSON.stringify(buildRequest(id)) + "\n");
    });
  }

  return {
    repoRoot,
    parentOf,
    attachLiveness,
    detachLiveness,
    closeAll,
    forwardEvent,
    forwardTool,
    blockingRequest,
  };
}

// ---------------------------------------------------------------------------
// Event dispatch
// ---------------------------------------------------------------------------

/** Record child→parent links from session.created/updated so later child events can be enriched. */
function learnParent(bridge, event) {
  const info = (event.properties || {}).info || {};
  if (typeof info.id === "string" && typeof info.parentID === "string") {
    bridge.parentOf.set(info.id, info.parentID);
  }
}

/** The event-bus events we forward + their liveness bookkeeping. Fire-and-forget; swallow all. */
function handleEvent(bridge, event) {
  const type = event && event.type;
  switch (type) {
    case "session.created":
    case "session.updated": {
      learnParent(bridge, event);
      const info = (event.properties || {}).info || {};
      // A top-level session (no parentID) gets a held-open liveness connection on first sight.
      if (type === "session.created" && typeof info.id === "string" && !info.parentID) {
        bridge.attachLiveness(info.id);
      }
      // session.updated is bookkeeping only (drives nothing downstream) — session.created is forwarded.
      if (type === "session.created") {
        bridge.forwardEvent(type, event);
      }
      return;
    }
    case "session.deleted": {
      const info = (event.properties || {}).info || {};
      if (typeof info.id === "string") {
        bridge.detachLiveness(info.id);
      }
      bridge.forwardEvent(type, event);
      return;
    }
    case "session.idle":
    case "permission.updated":
    case "permission.replied":
    case "file.edited":
      bridge.forwardEvent(type, event);
      return;
    case "message.updated": {
      // Only the user's own prompt is a turn-start signal downstream; assistant/tool messages are noise.
      const role = ((event.properties || {}).info || {}).role;
      if (role === "user") {
        bridge.forwardEvent(type, event);
      }
      return;
    }
    case "server.instance.disposed":
      // Graceful shutdown — close every held connection (process death handles the ungraceful case).
      bridge.closeAll();
      return;
    default:
      // session.error and any unmodelled event — drop (the strategy has no mapping for them anyway).
      return;
  }
}

// ---------------------------------------------------------------------------
// Client-driven automation (needs the OpenCode client; fail-open everywhere)
// ---------------------------------------------------------------------------

/** Switch the session to `targetAgent` and nudge it to proceed — plannotator's proven call shape
 *  (`noReply: true` so the nudge doesn't itself count as a user turn). Best-effort: a busy/gone
 *  session just leaves the agent where it is. */
async function switchAgent(client, sessionID, targetAgent) {
  try {
    await client.session.prompt({
      path: { id: sessionID },
      body: {
        agent: targetAgent,
        noReply: true,
        parts: [{ type: "text", text: "Proceed with implementation." }],
      },
    });
  } catch {
    // session busy / gone — fail open (the plan is still approved).
  }
}

/**
 * POST-HOC turn-end review: OpenCode's session.idle can't PARK the agent (it's fire-and-forget), so
 * instead of blocking we ask the extension (over our own connection) whether this idle turn warrants
 * feedback, and if it does, RESUME the now-idle agent by injecting the feedback as a new user turn.
 * The extension's existing onStopGate logic applies untouched (changedThisTurn via file.edited, the
 * comment bucket, the review slot, mute, fail-open). Loop safety mirrors Claude: a userPromptSubmit
 * resets changedThisTurn and the review slot serializes. STRICT fail-open: no window / timeout /
 * dropped socket / allow all inject NOTHING — feedback only ever reaches the agent on an explicit
 * Send Feedback (block + reason).
 */
async function postHocStopGate(bridge, client, sessionID) {
  const decision = await bridge.blockingRequest(
    (id) => ({
      t: "stop.gate.request",
      v: PLUGIN_VERSION,
      id,
      ts: nowIso(),
      harness: "opencode",
      repoRoot: bridge.repoRoot,
      // Synthetic idle event the OpenCodeStrategy maps to a top-level `stop`.
      event: { type: "session.idle", properties: { sessionID } },
    }),
    "stop.gate.response",
    (msg) => stopGateInjectionReason(msg),
    null, // fail-open: never inject on no-window / timeout / drop.
  );
  if (typeof decision === "string" && decision.trim()) {
    await injectFeedbackTurn(client, sessionID, decision);
  }
}

/** Inject review feedback as a new user turn (a plain prompt — no agent switch, no noReply), which
 *  resumes the idle agent so it addresses the feedback. Best-effort. */
async function injectFeedbackTurn(client, sessionID, reason) {
  try {
    await client.session.prompt({
      path: { id: sessionID },
      body: { parts: [{ type: "text", text: reason }] },
    });
  } catch {
    // session busy / gone — fail open.
  }
}

/** On a TOP-LEVEL session.idle, run the post-hoc turn-end gate. Child idles (subagents finishing) and
 *  any event without a resolvable session are ignored. */
function maybeRunStopGate(bridge, client, event) {
  if (!client || !event || event.type !== "session.idle") {
    return;
  }
  const sessionID = owningSessionId(event);
  if (!sessionID || isChildSession(sessionID, bridge.parentOf)) {
    return;
  }
  void postHocStopGate(bridge, client, sessionID);
}

// ---------------------------------------------------------------------------
// Plugin factory (autoloaded lazily by OpenCode on the first session op)
// ---------------------------------------------------------------------------

export const PairetoOpenCode = async ({ worktree, client, directory }) => {
  // Non-git dirs report worktree "/" (empirically confirmed) — there's no per-repo socket to bridge,
  // so register nothing. A missing worktree is treated the same.
  if (!worktree || worktree === "/") {
    return {};
  }

  const bridge = createBridge(worktree);

  // OpenCode provides `@opencode-ai/plugin` in its own runtime (never bundled with us); its
  // `tool.schema` is the zod instance we need to declare the plan tool's arg. Dynamic import — NOT a
  // top-level one — so this file's pure helpers stay importable in the unit tests (which don't have
  // the SDK installed and never invoke this factory). Fail-open: no SDK → the plan tool advertises
  // no args rather than crashing the session.
  let toolSchema = null;
  try {
    const sdk = await import("@opencode-ai/plugin");
    toolSchema = sdk && sdk.tool ? sdk.tool.schema : null;
  } catch {
    // Not running under OpenCode — leave the plan arg unschematized (never reached at runtime).
  }

  // The agents list is static per session; cache it (plannotator's pattern) so the system-prompt
  // transform doesn't re-fetch on every LLM call.
  let cachedAgents = null;
  async function loadAgents() {
    if (cachedAgents) {
      return cachedAgents;
    }
    try {
      const response = await client.app.agents({ query: { directory } });
      cachedAgents = response?.data ?? [];
    } catch {
      cachedAgents = [];
    }
    return cachedAgents;
  }

  return {
    // The event bus. Never throws into OpenCode; returns immediately (telemetry forwarding is
    // fire-and-forget; the post-hoc stop gate is dispatched async and awaited only internally).
    event: async ({ event }) => {
      try {
        handleEvent(bridge, event);
        maybeRunStopGate(bridge, client, event);
      } catch {
        // fail open — telemetry must never break a turn
      }
    },

    // Scope the plan tool to planning agents (mirrors plannotator's applyWorkflowConfig, lean). Runs
    // before every session; idempotent. Fail-open — a config error must not break the session.
    config: async (config) => {
      try {
        applyOpenCodeConfig(config, PLANNING_AGENTS);
      } catch {
        // fail open
      }
    },

    // Inject the lean planning instruction into a PLANNING session's system prompt so the agent
    // submits its plan via paireto_submit_plan instead of ending the turn (agent resolved like
    // plannotator: last user message's agent + cached app.agents; title-generator prompt skipped).
    "experimental.chat.system.transform": async (input, output) => {
      try {
        if (isTitleGeneratorPrompt(output.system.join("\n"))) {
          return;
        }
        const messages = await client.session.messages({ path: { id: input.sessionID } });
        const agentName = getLastUserAgentFromMessages(messages?.data);
        if (!agentName) {
          return;
        }
        const isSubagent = agentModeFor(agentName, await loadAgents()) === "subagent";
        if (
          shouldInjectPlanningPrompt({
            agentName,
            isSubagent,
            isTitleGenerator: false,
            planningAgents: PLANNING_AGENTS,
          })
        ) {
          output.system.push(PLANNING_PROMPT);
        }
      } catch {
        // fail open — never break a turn over prompt steering
      }
    },

    // Future-proofing: newer/forked OpenCode exposes a `plan_exit` tool (absent on 1.15.10). If it
    // shows up, point the agent at paireto_submit_plan instead. No-op today.
    "tool.definition": async (input, output) => {
      try {
        if (input && input.toolID === "plan_exit") {
          output.description =
            `Do not call this tool. Use ${SUBMIT_PLAN_TOOL} instead — it opens your plan for review ` +
            "in the user's connected VS Code window and waits for approval.";
        }
      } catch {
        // fail open
      }
    },

    // Awaited tool hooks: re-emit as synthetic events and RETURN IMMEDIATELY. Blocking here would
    // stall every tool call; the paireto_submit_plan plan gate rides the custom tool below, not here.
    "tool.execute.before": async (input) => {
      try {
        bridge.forwardTool("tool.execute.before", input);
      } catch {
        // fail open
      }
    },
    "tool.execute.after": async (input) => {
      try {
        bridge.forwardTool("tool.execute.after", input);
      } catch {
        // fail open
      }
    },

    // Custom tools whose execute() BLOCKS the agent until VS Code returns (analogous to the Claude
    // MCP `paireto_review` tool). `args: {}` = no arguments (empirically works with no zod).
    tool: {
      paireto_review: {
        description:
          "Open an interactive code review in the connected VS Code window and wait for the user " +
          "to submit feedback. Blocks until the user clicks Send Feedback or Cancel, then returns " +
          "the review comments (file:line, kind, note) to act on. Call this when the user asks for a review.",
        args: {},
        execute: async (_args, ctx) => {
          const sessionID = ctx && typeof ctx.sessionID === "string" ? ctx.sessionID : undefined;
          try {
            return await bridge.blockingRequest(
              (id) => ({
                t: "review.await.request",
                v: PLUGIN_VERSION,
                id,
                ts: nowIso(),
                cwd: bridge.repoRoot,
                repoRoot: bridge.repoRoot,
                sessionId: sessionID,
              }),
              "review.await.response",
              (msg) =>
                msg.status === "submitted" && msg.feedback
                  ? msg.feedback
                  : "Review approved — proceeding with no changes.",
              "No VS Code Paireto is listening for this repository — skipping the review.",
            );
          } catch {
            return "Review unavailable — proceeding with no changes.";
          }
        },
      },

      // Plan gate. The config hook + system-prompt transform steer planning agents onto this tool, so
      // it works with zero user setup (no way to intercept OpenCode's plan-mode exit directly —
      // session.idle is fire-and-forget). On APPROVE the extension may return a `nextMode` = the
      // TARGET AGENT to switch to (default `build`; "off" → omitted), closing the "no mode switch"
      // gap by prompting that agent to proceed.
      paireto_submit_plan: {
        description:
          "Submit your implementation plan for review in the connected VS Code window and wait for " +
          "the user's decision. Blocks until they approve or request changes. On changes, returns " +
          "the feedback to revise the plan against; on approval, returns a go-ahead. Call this once " +
          "you have a complete plan and want sign-off before implementing.",
        args: planToolArgs(toolSchema),
        execute: async (args, ctx) => {
          const sessionID = ctx && typeof ctx.sessionID === "string" ? ctx.sessionID : undefined;
          const plan = args && typeof args.plan === "string" ? args.plan : "";
          try {
            return await bridge.blockingRequest(
              (id) => ({
                t: "plan.review.request",
                v: PLUGIN_VERSION,
                id,
                ts: nowIso(),
                harness: "opencode",
                repoRoot: bridge.repoRoot,
                // Self-contained synthetic gate event per the seam invariant: the adapter injects the
                // plan markdown (OpenCode has no plan payload of its own).
                event: {
                  type: "paireto.plan.submitted",
                  properties: { sessionID },
                  plan_markdown: plan,
                },
              }),
              "plan.review.response",
              // onResponse is async: on approve with a target agent we switch BEFORE returning the
              // go-ahead (the round-trip socket is already closed by then; the switch is a separate
              // client call). Deny returns the feedback for the agent to revise against.
              async (msg) => {
                if (msg.decision === "deny") {
                  return msg.reason || "Plan changes requested.";
                }
                const targetAgent = typeof msg.nextMode === "string" ? msg.nextMode : undefined;
                if (targetAgent && sessionID && client) {
                  await switchAgent(client, sessionID, targetAgent);
                }
                return "Plan approved — proceed.";
              },
              "Plan review unavailable — proceeding.",
            );
          } catch {
            return "Plan review unavailable — proceeding.";
          }
        },
      },
    },
  };
};

// Test-only surface. OpenCode's plugin loader treats EVERY export as a plugin factory: a function
// export is invoked as `fn(pluginInput, options)` (a bare helper then crashes the boot — it reads
// its real parameters off the wrong objects), and a non-function export is a hard load error
// ("Plugin export is not a function"). So the helpers ride an INERT plugin: a callable that
// registers no hooks (async () => ({})), with the helpers attached as properties for the unit
// tests to destructure.
export const _internals = Object.assign(async () => ({}), {
  normalizePrimaryTools,
  ensurePermission,
  isPrimaryCapableAgent,
  applyOpenCodeConfig,
  isTitleGeneratorPrompt,
  getLastUserAgentFromMessages,
  agentModeFor,
  shouldInjectPlanningPrompt,
  isChildSession,
  stopGateInjectionReason,
  planToolArgs,
});

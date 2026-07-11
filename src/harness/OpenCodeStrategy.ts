// The OpenCode harness strategy: maps OpenCode's forwarded SDK events (see OpenCodeForwardedEvent)
// into the common AppEvent, owns edit-tool classification and plan-proposal detection, and renders
// the raw-event debug line. Like the other strategies this is the ONLY module that knows OpenCode's
// wire dialect. Empirically pinned against opencode 1.15.10 (see the adapter design notes).
//
// Subagent routing is the distinctive part: OpenCode models a sub-agent as a full child SESSION with
// its own id and a `parentID`. The plugin stamps `parentSessionID` on every event whose session it
// knows to be a child, so here a child event maps to the PARENT's row (`sessionId: parentSessionID`)
// carrying the child's own id as `agentId` — which makes AgentSessionService treat it as subagent
// activity (the agentId bailout) instead of a top-level row. A child's session.idle/deleted becomes
// subagentStop; a top-level session.idle becomes stop, session.deleted becomes sessionEnd.
//
// OpenCode's session.idle can't PARK the agent (it's fire-and-forget), so turn-end review is POST-HOC:
// the plugin fires a stop.gate.request on each top-level idle and, on block+reason, injects the
// feedback as a fresh user turn to resume the (already-idle) agent — mapped here identically to any
// other harness's `stop`, the extension's onStopGate logic is untouched. It DOES have a live
// process-death signal (the plugin holds a socket open per top-level session), so supportsLiveness is
// true. On plan approval `nextMode` is the target agent to switch to (default `build`), not a
// permission mode — see defaultPlanApproveMode.

import type { Harness } from "../protocol/types.js";
import type { AppEvent, AppEventKind } from "./appEvent.js";
import type { AgentStrategy } from "./AgentStrategy.js";

// --- OpenCode wire dialect ----------------------------------------------------------------------
// The forwarded-event shapes live HERE (colocated with the only module that consumes them), not in
// protocol/types.ts — that file re-imports them type-only for the HarnessHookEvent union. OpenCode
// has no snake_case hook stdin like Claude/Codex; the plugin runs in-process and forwards structured
// SDK events over the socket, so these are the wire shapes the extension receives.

/** Forwarded-event `type` values the OpenCode adapter emits: real SDK event types plus the two
 *  synthetic ones the plugin fabricates from awaited (non-event-bus) hooks and the plan tool. */
export type OpenCodeEventType =
  | "session.created"
  | "session.updated"
  | "session.deleted"
  | "session.idle"
  | "session.error"
  | "permission.updated"
  | "permission.replied"
  | "file.edited"
  | "message.updated"
  // Synthetic: the plugin's awaited tool.execute.before/after hooks re-emitted as events.
  | "tool.execute.before"
  | "tool.execute.after"
  // Synthetic: the paireto_submit_plan custom tool's plan submission.
  | "paireto.plan.submitted";

/** The subset of an OpenCode `Session` object the adapter consumes (the SDK `Session` has more). */
export interface OpenCodeSessionInfo {
  id: string;
  /** Set on a child (sub-)session; drives subagent routing (verified live via `POST /session`). */
  parentID?: string;
}

/** The subset of an OpenCode `Permission` object the adapter consumes. */
export interface OpenCodePermission {
  id: string;
  sessionID: string;
  type: string;
  title?: string;
  callID?: string;
}

/** Properties carried by a forwarded OpenCode event — a union over the consumed event shapes. Every
 *  field is optional; which are present depends on `type` and is narrowed at runtime by the mapper
 *  via the `type` tag (the harness guarantee, not compile-time — mapper fixture tests are the net). */
export interface OpenCodeEventProperties {
  /** session.* events: the full session object (the adapter reads `id` + `parentID`). */
  info?: OpenCodeSessionInfo;
  /** permission.updated: the permission object. */
  permission?: OpenCodePermission;
  /** The owning session id — stamped by the plugin on every forwarded event. */
  sessionID?: string;
  /** permission.replied. */
  permissionID?: string;
  response?: string;
  /** tool.execute.before/after synthetic events: the tool name + its call id. */
  tool?: string;
  callID?: string;
  /** message.updated: the message role (the adapter consumes only `"user"`). */
  role?: string;
  /** file.edited: the edited file path. */
  file?: string;
}

/**
 * One OpenCode event as forwarded by the adapter's plugin — the raw SDK event's `{type, properties}`
 * plus two plugin-stamped fields.
 */
export interface OpenCodeForwardedEvent {
  type: OpenCodeEventType;
  properties: OpenCodeEventProperties;
  /** PLUGIN-INJECTED, not part of the SDK event: the parent session id when this event's session is
   *  a known child. The plugin keeps the sessionID→parentID map from session.created/updated —
   *  cross-event correlation is plugin-side per the seam invariant. */
  parentSessionID?: string;
  /** ADAPTER-INJECTED: plan markdown from the paireto_submit_plan tool's synthetic event. Present
   *  only on a plan.review.request event. */
  plan_markdown?: string;
}
// ------------------------------------------------------------------------------------------------

/** OpenCode tools that edit working-tree files. Best-effort — OpenCode has no turn-end Stop gate, so
 *  this only feeds the (never-parking) changed-this-turn flag; it is not review-critical. */
const EDIT_TOOLS: ReadonlySet<string> = new Set<string>(["edit", "write", "patch"]);

/** The custom tool whose invocation is a plan proposal (opt-in — the agent must be instructed to call
 *  it). Its blocking round-trip is the plan gate; the tool.execute.before edge is the telemetry. */
const PLAN_TOOL = "paireto_submit_plan";

export class OpenCodeStrategy implements AgentStrategy {
  readonly harness: Harness = "opencode";
  readonly displayName = "OpenCode";
  readonly planToolName = PLAN_TOOL;
  // For OpenCode `nextMode` is not a permission mode but the TARGET AGENT to switch to on approval
  // (the plugin's paireto_submit_plan tool prompts it to proceed). Default to `build` so an approved
  // plan hands off to the implementer; `paireto.planApprove.mode.opencode` overrides it, "off" stays.
  readonly defaultPlanApproveMode: string | undefined = "build";
  // The plugin holds a per-top-level-session liveness socket open; the OS dropping it on process
  // death clears the row directly — no silence sweep needed.
  readonly supportsLiveness = true;

  toAppEvent(event: OpenCodeForwardedEvent): AppEvent | undefined {
    const props = event.properties;

    // session.created decides top-level vs subagent by the child's own parentID.
    if (event.type === "session.created") {
      const info = props.info;
      if (!info?.id) {
        return undefined;
      }
      if (info.parentID) {
        return this.build("subagentStart", info.parentID, event, info.id);
      }
      return this.build("sessionStart", info.id, event);
    }

    // Any event the plugin tagged with a parent belongs to a child session — route it to the parent
    // row, carrying the child id as agentId. A child's own idle/deleted is its subagentStop.
    if (event.parentSessionID) {
      const child = props.sessionID;
      if (!child) {
        return undefined;
      }
      if (event.type === "session.idle" || event.type === "session.deleted") {
        return this.build("subagentStop", event.parentSessionID, event, child);
      }
      const childKind = this.baseKind(event);
      if (!childKind) {
        return undefined;
      }
      return this.build(childKind, event.parentSessionID, event, child);
    }

    // Top-level lifecycle: idle ends the turn (stop), deleted ends the session.
    if (event.type === "session.idle") {
      return this.topLevel("stop", props);
    }
    if (event.type === "session.deleted") {
      return this.topLevel("sessionEnd", props);
    }
    const kind = this.baseKind(event);
    if (!kind) {
      return undefined;
    }
    return this.topLevel(kind, props, event);
  }

  describeEvent(event: OpenCodeForwardedEvent): string {
    const props = event.properties;
    const session = props.sessionID ?? props.info?.id;
    const agent = session ? ` agent=${session.slice(0, 8)}` : "";
    const parent = event.parentSessionID ? ` parent=${event.parentSessionID.slice(0, 8)}` : "";
    const tool = props.tool ? ` tool=${props.tool}` : "";
    return `${event.type}${agent}${parent}${tool}`;
  }

  /** Map a non-lifecycle event type to its common kind (or undefined to drop). Lifecycle events
   *  (session.created/idle/deleted) are decided by the caller based on top-level vs child. */
  private baseKind(event: OpenCodeForwardedEvent): AppEventKind | undefined {
    switch (event.type) {
      case "message.updated":
        // Only the user's own prompt is a turn-start signal; other roles were filtered plugin-side
        // but re-check here so the mapper is self-contained.
        return event.properties.role === "user" ? "userPromptSubmit" : undefined;
      case "permission.updated":
        return "permissionRequest";
      case "file.edited":
        return "fileChanged";
      case "tool.execute.before":
        return event.properties.tool === PLAN_TOOL ? "planProposal" : "preToolUse";
      case "tool.execute.after":
        return "postToolUse";
      case "paireto.plan.submitted":
        return "planProposal";
      default:
        // session.error, session.updated, permission.replied, and anything unmodelled → drop.
        return undefined;
    }
  }

  /** Build a top-level AppEvent (no agentId) keyed on the stamped owning sessionID. */
  private topLevel(
    kind: AppEventKind,
    props: OpenCodeEventProperties,
    event?: OpenCodeForwardedEvent,
  ): AppEvent | undefined {
    if (!props.sessionID) {
      return undefined;
    }
    return this.build(kind, props.sessionID, event, undefined, props);
  }

  private build(
    kind: AppEventKind,
    sessionId: string,
    event?: OpenCodeForwardedEvent,
    agentId?: string,
    propsOverride?: OpenCodeEventProperties,
  ): AppEvent {
    const props = propsOverride ?? event?.properties;
    const toolName = props?.tool;
    return {
      kind,
      harness: this.harness,
      sessionId,
      agentId,
      toolName,
      isEditTool: EDIT_TOOLS.has(toolName ?? ""),
      // Present only on the blocking plan-gate event (paireto.plan.submitted); the tool.execute.before
      // plan edge carries no text (it's just the awaiting-plan telemetry edge).
      planText: event?.plan_markdown,
      // OpenCode reports no background-task/session-cron counts.
      backgroundTaskCount: 0,
      sessionCronCount: 0,
    };
  }
}

// Event dispatch and the client-driven automation that needs the OpenCode client. Fail-open
// everywhere: a broken window must degrade the feature, never stall or crash a turn.

import { isChildSession, isNewUserTurn, stopGateInjectionReason } from "./automation.js";
import type { OpenCodeBridge } from "./bridge.js";
import { owningSessionId } from "./eventShape.js";
import { PROCEED_NUDGE } from "./text.js";
import type { OpenCodeClient, OpenCodeEvent } from "./types.js";

/** Record child→parent links from session.created/updated so later child events can be enriched. */
function learnParent(bridge: OpenCodeBridge, event: OpenCodeEvent): void {
  const info = event.properties?.info ?? {};
  if (typeof info.id === "string" && typeof info.parentID === "string") {
    bridge.parentOf.set(info.id, info.parentID);
  }
}

/** The event-bus events we forward, plus their liveness bookkeeping. Fire-and-forget; swallow all. */
export function handleEvent(bridge: OpenCodeBridge, event: OpenCodeEvent): void {
  const type = event?.type;
  switch (type) {
    case "session.created":
    case "session.updated": {
      learnParent(bridge, event);
      const info = event.properties?.info ?? {};
      // A top-level session (no parentID) gets a held-open liveness connection on first sight.
      if (type === "session.created" && typeof info.id === "string" && !info.parentID) {
        bridge.attachLiveness(info.id);
      }
      // session.updated is bookkeeping only (it drives nothing downstream).
      if (type === "session.created") {
        bridge.forwardEvent(type, event);
      }
      return;
    }
    case "session.deleted": {
      const info = event.properties?.info ?? {};
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
      // Only the user's own prompt is a turn-start signal downstream (assistant/tool messages are
      // noise) AND only on its FIRST sighting — OpenCode re-fires message.updated for the same user
      // message at turn end, and a repeat forward would reset changedThisTurn AFTER the turn's edits.
      if (isNewUserTurn(bridge.seenUserMessages, event.properties?.info)) {
        bridge.forwardEvent(type, event);
      }
      return;
    }
    case "server.instance.disposed":
      // Graceful shutdown — close every held connection (process death handles the ungraceful case).
      bridge.closeAll();
      return;
    default:
      // session.error and any unmodelled event — the strategy has no mapping for them anyway.
      return;
  }
}

/** Switch the session to `targetAgent` and nudge it to proceed (`noReply: true` so the nudge doesn't
 *  itself count as a user turn). Best-effort: a busy or gone session just leaves the agent where it is. */
export async function switchAgent(
  client: OpenCodeClient,
  sessionID: string,
  targetAgent: string,
): Promise<void> {
  try {
    await client.session.prompt({
      path: { id: sessionID },
      body: {
        agent: targetAgent,
        noReply: true,
        parts: [{ type: "text", text: PROCEED_NUDGE }],
      },
    });
  } catch {
    // session busy / gone — fail open (the plan is still approved).
  }
}

/** Inject review feedback as a new user turn (a plain prompt — no agent switch, no noReply), which
 *  resumes the idle agent so it addresses the feedback. Best-effort. */
async function injectFeedbackTurn(
  client: OpenCodeClient,
  sessionID: string,
  reason: string,
): Promise<void> {
  try {
    await client.session.prompt({
      path: { id: sessionID },
      body: { parts: [{ type: "text", text: reason }] },
    });
  } catch {
    // session busy / gone — fail open.
  }
}

/**
 * POST-HOC turn-end review: OpenCode's session.idle can't PARK the agent (it's fire-and-forget), so
 * instead of blocking we ask the extension whether this idle turn warrants feedback, and if it does,
 * RESUME the now-idle agent by injecting the feedback as a new user turn. The extension's existing
 * stop-gate logic applies untouched. STRICT fail-open: no window / timeout / dropped socket / allow
 * all inject NOTHING — feedback only ever reaches the agent on an explicit Send Feedback.
 */
async function postHocStopGate(
  bridge: OpenCodeBridge,
  client: OpenCodeClient,
  sessionID: string,
): Promise<void> {
  const response = await bridge.gate({
    t: "stop.gate.request",
    harness: "opencode",
    repoRoot: bridge.repoRoot,
    // Synthetic idle event the OpenCodeStrategy maps to a top-level `stop`.
    event: { type: "session.idle", properties: { sessionID } } as never,
  });
  const reason = stopGateInjectionReason(response);
  if (reason) {
    await injectFeedbackTurn(client, sessionID, reason);
  }
}

/** On a TOP-LEVEL session.idle, run the post-hoc turn-end gate. Child idles (subagents finishing) and
 *  any event without a resolvable session are ignored. */
export function maybeRunStopGate(
  bridge: OpenCodeBridge,
  client: OpenCodeClient | undefined,
  event: OpenCodeEvent | undefined,
): void {
  if (!client || !event || event.type !== "session.idle") {
    return;
  }
  const sessionID = owningSessionId(event);
  if (!sessionID || isChildSession(sessionID, bridge.parentOf)) {
    return;
  }
  void postHocStopGate(bridge, client, sessionID);
}

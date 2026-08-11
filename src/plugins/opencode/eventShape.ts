// Event-shape plumbing: which session owns a raw SDK event, and the curated properties forwarded on
// the wire. Plumbing only — never semantic mapping, which is the extension strategy's job.

import type { OpenCodeEvent, OpenCodeEventProperties } from "./types.js";

/** The owning session id for a raw SDK event, per type. session.* carry it on `properties.info.id`;
 *  permission.* on `properties.sessionID`; message.updated on `properties.info.sessionID`. Returns
 *  undefined when it can't be resolved (that event is then dropped). */
export function owningSessionId(event: OpenCodeEvent): string | undefined {
  const props = event.properties ?? {};
  const info = props.info ?? {};
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

/** The curated properties the extension's OpenCodeStrategy reads. Always stamps `sessionID`; carries
 *  `info` (id + parentID) for session events, `role` for messages, `file` for file.edited. */
export function curatedProperties(
  event: OpenCodeEvent,
  sessionID: string,
): OpenCodeEventProperties {
  const props = event.properties ?? {};
  const info = props.info ?? {};
  const out: OpenCodeEventProperties = { sessionID };
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

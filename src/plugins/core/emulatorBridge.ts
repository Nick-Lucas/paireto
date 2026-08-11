// Dev-only entry point for scripts/emulator.ts.
//
// The emulator runs under Node's type stripping, which does not resolve a `.js` specifier to a
// `.ts` file, so it cannot import the plugin sources directly. esbuild bundles this module to
// dist/plugin-bridge.js instead. It exposes the raw transport rather than the typed client because
// the emulator exists to print and hand-craft individual frames.

import * as net from "node:net";

import { canonicalize, repoKey, socketDir, socketPath, stateDir } from "../../protocol/paths.js";
import { PLUGIN_VERSION } from "../../protocol/types.js";
import { handshake, nowIso, readMessages, sendLine } from "./ndjson.js";
import { gitToplevel, resolveTarget } from "./target.js";

export interface EmulatorConnection {
  sock: net.Socket;
  residual: string;
}

/** Rejects on failure — the emulator is an interactive tool and reports the reason to the user. */
export async function connectAndHandshake(
  socketPathArg: string,
  repoRoot: string,
  timeoutMs: number,
): Promise<EmulatorConnection> {
  const result = await handshake(socketPathArg, repoRoot, timeoutMs);
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return { sock: result.connection.sock, residual: result.connection.residual };
}

export {
  canonicalize,
  gitToplevel,
  nowIso,
  PLUGIN_VERSION,
  readMessages,
  repoKey,
  resolveTarget,
  sendLine,
  socketDir,
  socketPath,
  stateDir,
};

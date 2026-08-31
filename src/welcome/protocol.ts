// Shared message + state contracts between the node extension host (WelcomePanel) and the React
// webview. Type-only — imported as `import type` on both sides, so no runtime code crosses over.

/** Bridge-plugin install status used by the Welcome card. */
export type InstallState = "installed" | "update-available" | "not-installed";

export interface AgentState {
  id: string;
  name: string;
  available: boolean;
  installState: InstallState;
  /** The plugin version this agent's own registry reports. Absent when it carries no plugin, or
   *  when the agent could not be asked (its CLI is not on PATH). */
  installedVersion?: string;
  /** The plugin version this extension ships for that agent. Absent for a planned agent. */
  shippedVersion?: string;
  /** Name of the agent's terminal profile, if it defines one. */
  profileName?: string;
  /** True when that terminal profile already exists in the user's settings. */
  profileConfigured: boolean;
  /** Static setup note shown under the card (e.g. an opt-in feature the user enables themselves). */
  note?: string;
}

export interface ShortcutState {
  id: string;
  label: string;
  command: string;
  recommended: string;
  current?: string;
  currentSource?: "user" | "default";
  isSet: boolean;
  when?: string;
}

/** What this window is, for reading against the per-agent plugin versions. A plugin only talks to
 *  the extension when its version equals {@link VersionState.plugin} exactly, so the two numbers
 *  together are the whole diagnosis when an agent stops reaching Paireto. */
export interface VersionState {
  /** The VS Code extension's own release version. */
  extension: string;
  /** The wire version this extension speaks — the one the bridge handshake compares. */
  plugin: string;
}

export interface WelcomeState {
  /** asWebviewUri of the header logo (computed host-side since the webview can't). */
  logoUri: string;
  versions: VersionState;
  agents: AgentState[];
  shortcuts: ShortcutState[];
}

/** Extension host → webview. */
export type OutboundMessage =
  | { type: "state"; state: WelcomeState }
  | { type: "agentBusy"; agentId: string }
  | { type: "agentResult"; agentId: string; ok: boolean; detail: string };

/** Webview → extension host. */
export type InboundMessage =
  | { type: "requestState" }
  | { type: "setKeybinding"; id: string }
  | { type: "setAllKeybindings" }
  | { type: "setupAgent"; agentId: string }
  | { type: "setupProfile"; agentId: string }
  /** Open the Keyboard Shortcuts UI, optionally pre-filtered to `query` (e.g. a command id). */
  | { type: "openKeybindings"; query?: string };

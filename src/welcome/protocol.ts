// Shared message + state contracts between the node extension host (WelcomePanel) and the React
// webview. Type-only — imported as `import type` on both sides, so no runtime code crosses over.

/** Tri-state bridge-plugin install status → the card's action: not-installed → "Set up",
 *  update-available (present but at a stale version) → "Update", installed → "✓ Installed". */
export type InstallState = "installed" | "update-available" | "not-installed";

export interface AgentState {
  id: string;
  name: string;
  available: boolean;
  installState: InstallState;
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

export interface WelcomeState {
  /** asWebviewUri of the header logo (computed host-side since the webview can't). */
  logoUri: string;
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

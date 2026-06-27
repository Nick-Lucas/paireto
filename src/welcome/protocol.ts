// Shared message + state contracts between the node extension host (WelcomePanel) and the React
// webview. Type-only — imported as `import type` on both sides, so no runtime code crosses over.

export interface AgentState {
  id: string;
  name: string;
  available: boolean;
  installed: boolean;
  /** Name of the agent's terminal profile, if it defines one. */
  profileName?: string;
  /** True when that terminal profile already exists in the user's settings. */
  profileConfigured: boolean;
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

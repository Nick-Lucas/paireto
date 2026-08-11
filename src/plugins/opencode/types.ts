// Structural types for the OpenCode host surface.
//
// Written by hand rather than taken from `@opencode-ai/plugin`: that package is resolved from
// OpenCode's own Bun runtime and must never be bundled with us or installed as a dependency, so the
// only safe description of it is one we own. Every shape here is the subset this adapter touches.

export interface AgentConfig {
  mode?: string;
  permission?: Record<string, unknown> | string;
  [key: string]: unknown;
}

export interface OpenCodeConfig {
  experimental?: { primary_tools?: unknown; [key: string]: unknown };
  agent?: Record<string, AgentConfig>;
  [key: string]: unknown;
}

/** A named agent as reported by `client.app.agents`. */
export interface AgentInfo {
  name?: string;
  mode?: string;
}

/** The `info` half of a `{ info, parts }` message entry. */
export interface MessageInfo {
  id?: string;
  role?: string;
  agent?: string;
  sessionID?: string;
  parentID?: string;
}

export interface MessageEntry {
  info?: MessageInfo;
}

export interface OpenCodeEventProperties {
  sessionID?: string;
  info?: MessageInfo;
  file?: string;
  [key: string]: unknown;
}

export interface OpenCodeEvent {
  type?: string;
  properties?: OpenCodeEventProperties;
}

/** The awaited `tool.execute.before/after` hook input. */
export interface ToolExecuteInput {
  sessionID?: string;
  tool?: string;
  callID?: string;
}

export interface OpenCodeClient {
  session: {
    prompt(request: {
      path: { id: string };
      body: {
        agent?: string;
        noReply?: boolean;
        parts: Array<{ type: string; text: string }>;
      };
    }): Promise<unknown>;
    messages(request: { path: { id: string } }): Promise<{ data?: MessageEntry[] } | undefined>;
  };
  app: {
    agents(request: { query: { directory?: string } }): Promise<{ data?: AgentInfo[] } | undefined>;
  };
}

export interface PluginInput {
  worktree?: string;
  directory?: string;
  client: OpenCodeClient;
}

/** The zod handle OpenCode exposes as `tool.schema`; only `.string().describe()` is used. */
export interface ToolSchema {
  string(): { describe(text: string): unknown };
}

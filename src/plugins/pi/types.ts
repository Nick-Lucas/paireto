export interface PiJsonSchema {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export interface PiToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
}

export interface PiSessionManager {
  getSessionId(): string;
  getCwd(): string;
}

export interface PiUiContext {
  notify(message: string, level?: "info" | "warning" | "error"): void;
}

export type PiMode = "tui" | "rpc" | "json" | "print";

export interface PiExtensionContext {
  cwd: string;
  mode: PiMode;
  hasUI: boolean;
  ui: PiUiContext;
  sessionManager: PiSessionManager;
  isIdle(): boolean;
}

export interface PiToolDefinition<TParams> {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];
  parameters: PiJsonSchema;
  execute(
    toolCallId: string,
    params: TParams,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: PiExtensionContext,
  ): Promise<PiToolResult>;
}

export interface PiSessionStartEvent {
  type: "session_start";
  reason: string;
}

export interface PiSessionShutdownEvent {
  type: "session_shutdown";
  reason: string;
}

export interface PiBeforeAgentStartEvent {
  type: "before_agent_start";
  prompt: string;
  systemPrompt: string;
}

export interface PiBeforeAgentStartResult {
  systemPrompt?: string;
}

export interface PiToolCallEvent {
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface PiToolCallResult {
  block?: boolean;
  reason?: string;
}

export interface PiToolExecutionStartEvent {
  type: "tool_execution_start";
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export interface PiToolExecutionEndEvent {
  type: "tool_execution_end";
  toolCallId: string;
  toolName: string;
  isError: boolean;
}

export interface PiAgentSettledEvent {
  type: "agent_settled";
}

export type PiHandler<E, R = void> = (
  event: E,
  ctx: PiExtensionContext,
) => Promise<R | void> | R | void;

export interface PiCommandOptions {
  description?: string;
  handler: (args: string, ctx: PiExtensionContext) => Promise<void>;
}

export interface PiExtensionAPI {
  on(event: "session_start", handler: PiHandler<PiSessionStartEvent>): void;
  on(event: "session_shutdown", handler: PiHandler<PiSessionShutdownEvent>): void;
  on(
    event: "before_agent_start",
    handler: PiHandler<PiBeforeAgentStartEvent, PiBeforeAgentStartResult>,
  ): void;
  on(event: "tool_call", handler: PiHandler<PiToolCallEvent, PiToolCallResult>): void;
  on(event: "tool_execution_start", handler: PiHandler<PiToolExecutionStartEvent>): void;
  on(event: "tool_execution_end", handler: PiHandler<PiToolExecutionEndEvent>): void;
  on(event: "agent_settled", handler: PiHandler<PiAgentSettledEvent>): void;
  registerTool<TParams>(tool: PiToolDefinition<TParams>): void;
  registerCommand(name: string, options: PiCommandOptions): void;
  sendUserMessage(
    content: string,
    options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
  ): void;
}

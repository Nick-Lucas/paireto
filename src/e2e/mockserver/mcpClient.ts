// Minimal MCP-over-Streamable-HTTP client for driving MockServer's control tools (record_llm_fixtures,
// load_expectations_from_file, set_operating_mode, …). MockServer 7.4 exposes these EXCLUSIVELY as MCP
// tools at POST /mockserver/mcp — there is no HTTP control-plane equivalent — so the record/check
// orchestration has to speak JSON-RPC. This is deliberately tiny (no MCP SDK): one handshake, then
// tools/call. Host-runner only (uses global fetch; never imported by the extension bundle).
//
// Wire notes verified against mockserver/mockserver:mockserver-7.4.0: `initialize` returns the session
// id in the `Mcp-Session-Id` RESPONSE HEADER (not the body); every later call must echo it back. A
// `notifications/initialized` must follow before tools/call. Responses arrive as plain JSON or as a
// single-message text/event-stream depending on server mood, so we parse both.

const PROTOCOL_VERSION = "2024-11-05";

export interface JsonRpcResponse {
  result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  error?: { code: number; message: string };
}

export class McpClient {
  private sessionId?: string;
  private nextId = 1;

  /** @param url the full MCP endpoint, e.g. http://127.0.0.1:11080/mockserver/mcp */
  constructor(private readonly url: string) {}

  /** Handshake: initialize → capture session id → notifications/initialized. Idempotent-ish; call once. */
  async connect(): Promise<void> {
    const res = await this.post({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "paireto-e2e", version: "1" },
      },
    });
    const sid = res.headers.get("mcp-session-id");
    if (!sid) {
      throw new Error("MockServer MCP initialize returned no Mcp-Session-Id header");
    }
    this.sessionId = sid;
    await readBody(res); // drain
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  /** Call a tool and return its concatenated text content. Throws on a JSON-RPC error or tool isError. */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const res = await this.post({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "tools/call",
      params: { name, arguments: args },
    });
    const body = await readBody(res);
    const rpc = extractJsonRpc(body);
    if (rpc.error) {
      throw new Error(`MCP tool ${name} failed: ${rpc.error.message} (code ${rpc.error.code})`);
    }
    const text = (rpc.result?.content ?? [])
      .map((c) => c.text ?? "")
      .join("")
      .trim();
    if (rpc.result?.isError) {
      throw new Error(`MCP tool ${name} reported an error: ${text}`);
    }
    return text;
  }

  private post(payload: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.sessionId) {
      headers["Mcp-Session-Id"] = this.sessionId;
    }
    return fetch(this.url, { method: "POST", headers, body: JSON.stringify(payload) });
  }
}

/** Read a response body as text (works for both application/json and text/event-stream). */
async function readBody(res: Response): Promise<string> {
  return res.text();
}

/** Pull the JSON-RPC message out of a body that's either raw JSON or a `data:`-prefixed SSE frame. */
export function extractJsonRpc(body: string): JsonRpcResponse {
  const trimmed = body.trim();
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed) as JsonRpcResponse;
  }
  // SSE: find the last `data:` line and parse its JSON payload.
  const dataLines = trimmed
    .split(/\r?\n/)
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice("data:".length).trim());
  const last = dataLines.at(-1);
  if (!last) {
    throw new Error(`MCP response had no parseable body: ${trimmed.slice(0, 200)}`);
  }
  return JSON.parse(last) as JsonRpcResponse;
}

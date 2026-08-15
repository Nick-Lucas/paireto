Agent Plugins v1 package for [compatible clients](https://agent-plugins.org/compatible-clients).

For Paireto this is currently:

- Codex
- Kiro CLI

`plugin.json`, `mcp.json`, `skills/`, and the shared MCP runtime are portable components.
Client-specific configuration, hooks, and session adapters stay in the top-level
`com.openai.codex/` and `dev.kiro/` extension namespaces.

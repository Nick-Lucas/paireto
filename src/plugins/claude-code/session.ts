// How the Claude Code plugin processes learn where they are and which session they belong to.

/** The project directory Claude Code exports to its hooks and MCP servers. */
export function claudeCwd(): string {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

/**
 * Session id for attributing a review to an agent row. Best-effort: when it is absent the
 * extension falls back to the most-recently-active session in the repo.
 */
export function reviewSessionId(): string | undefined {
  return process.env.CLAUDE_SESSION_ID || undefined;
}

/**
 * Session id for the liveness attach. This is a DIFFERENT variable to {@link reviewSessionId} and
 * the two are not interchangeable. Without it there is no session row to correlate against, so
 * liveness tracking is simply skipped.
 */
export function livenessSessionId(): string | undefined {
  return process.env.CLAUDE_CODE_SESSION_ID || undefined;
}

// Resolves the name shown as the author on inline review/plan comments. Preference order: the VS Code
// signed-in account (GitHub, then Microsoft), then the OS login name, then "Developer". The signed-in
// lookup is async (and best-effort, silent — it never prompts), so we resolve once at activation and
// cache the result; GateComment reads the cached value synchronously when it renders a comment.

import * as os from "node:os";

import * as vscode from "vscode";

/** Built-in authentication providers worth checking for a human-readable account label, in order. */
const AUTH_PROVIDERS = ["github", "microsoft"] as const;

let cached = "Developer";

/** The cached author name (sync). Returns "Developer" until {@link resolveCommentAuthor} completes. */
export function commentAuthorName(): string {
  return cached;
}

/** Apply the fallback chain. Exported pure for unit testing. */
export function pickAuthorName(authLabel?: string, osUsername?: string): string {
  return authLabel?.trim() || osUsername?.trim() || "Developer";
}

/** The OS login name, or undefined if it can't be read. */
function osUsername(): string | undefined {
  try {
    return os.userInfo().username;
  } catch {
    return undefined;
  }
}

/** A signed-in account label from the first available built-in provider (silent — never prompts). */
async function signedInLabel(): Promise<string | undefined> {
  for (const provider of AUTH_PROVIDERS) {
    try {
      const session = await vscode.authentication.getSession(provider, [], { silent: true });
      const label = session?.account.label?.trim();
      if (label) {
        return label;
      }
    } catch {
      // Provider not installed / not signed in — try the next one.
    }
  }
  return undefined;
}

/** Resolve and cache the comment author name. Call once at activation; safe to call again. */
export async function resolveCommentAuthor(): Promise<string> {
  cached = pickAuthorName(await signedInLabel(), osUsername());
  return cached;
}

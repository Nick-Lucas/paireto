// VS Code's commenting gutter "+" is gated by the global `comments.visible` setting (toggled by the
// "Toggle Editor Commenting" command). There is NO per-scheme override, so when a user has turned it
// off (commonly to silence GitHub PR comments), our plan/review commenting silently won't work.
//
// We can't scope it to our URIs, so instead we detect it's off and offer to re-enable it — never
// flipping a deliberately-disabled setting without consent. Warned at most once per session.

import * as vscode from "vscode";

let warnedThisSession = false;

/** If commenting is globally disabled, warn once and offer to enable it (workspace or global). */
export async function ensureCommentingVisible(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("comments");
  // Default is true; only act when explicitly disabled.
  if (cfg.get<boolean>("visible") !== false) {
    return;
  }
  if (warnedThisSession) {
    return;
  }
  warnedThisSession = true;

  const enableWorkspace = "Enable in This Workspace";
  const enableGlobal = "Enable Everywhere";
  const choice = await vscode.window.showWarningMessage(
    'Editor commenting is turned off ("comments.visible"), so the gutter "+" to comment on plans and reviews won\'t appear. Enable it?',
    enableWorkspace,
    enableGlobal,
    "Dismiss"
  );
  if (choice === enableWorkspace) {
    await cfg.update("visible", true, vscode.ConfigurationTarget.Workspace);
  } else if (choice === enableGlobal) {
    await cfg.update("visible", true, vscode.ConfigurationTarget.Global);
  }
}

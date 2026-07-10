// Readers for the built-in VS Code editor settings we honour (so our surfaces behave like the
// native ones instead of ignoring the user's preferences).

import * as vscode from "vscode";

/** The effective value of `explorer.autoReveal`: reveal + select on focus, off, or reveal without
 *  scrolling. Truthy means a tree should follow the active editor (we can't suppress the scroll via
 *  the TreeView API, so `"focusNoScroll"` behaves like `true`). */
export type AutoReveal = boolean | "focusNoScroll";

/** The user's effective `explorer.autoReveal`, as its {@link AutoReveal} value. */
export function getAutoRevealSetting(): AutoReveal {
  const autoReveal = vscode.workspace.getConfiguration("explorer").get("autoReveal");
  if (autoReveal === "focusNoScroll") {
    return "focusNoScroll";
  }
  return autoReveal !== false;
}

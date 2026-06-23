// Small helpers for closing editor tabs by URI/scheme and toggling the bottom panel. Used by the
// gate flows to auto-close a resolved plan, sweep leftover virtual diff tabs (so they stop showing
// up in full-text search), and hide/show the terminal panel during plan review.

import * as vscode from "vscode";

/** The resource URI backing a tab (text or diff base), or undefined for other tab kinds. */
export function tabUri(tab: vscode.Tab): vscode.Uri | undefined {
  const input = tab.input;
  if (input instanceof vscode.TabInputText) {
    return input.uri;
  }
  if (input instanceof vscode.TabInputTextDiff) {
    return input.modified;
  }
  return undefined;
}

/** Close every open tab whose text/diff input matches `predicate`. */
export async function closeTabsWhere(predicate: (tab: vscode.Tab) => boolean): Promise<void> {
  const targets: vscode.Tab[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (predicate(tab)) {
        targets.push(tab);
      }
    }
  }
  if (targets.length) {
    await vscode.window.tabGroups.close(targets, true);
  }
}

/** Close any tab (text doc or diff) that references the given URI on either side. */
export async function closeTabsForUri(uri: vscode.Uri): Promise<void> {
  const target = uri.toString();
  await closeTabsWhere((tab) => {
    const input = tab.input;
    if (input instanceof vscode.TabInputText) {
      return input.uri.toString() === target;
    }
    if (input instanceof vscode.TabInputTextDiff) {
      return input.original.toString() === target || input.modified.toString() === target;
    }
    return false;
  });
}

/** Close any diff tab whose original/base side uses the given scheme (our read-only virtual sides). */
export async function closeDiffTabsWithBaseScheme(scheme: string): Promise<void> {
  await closeTabsWhere(
    (tab) => tab.input instanceof vscode.TabInputTextDiff && tab.input.original.scheme === scheme,
  );
}

/** Hide the bottom Panel (where the integrated terminal lives). */
export async function hideBottomPanel(): Promise<void> {
  await vscode.commands.executeCommand("workbench.action.closePanel");
}

/** Reopen + focus the integrated terminal (restores the panel hidden by {@link hideBottomPanel}). */
export async function showTerminalPanel(): Promise<void> {
  await vscode.commands.executeCommand("workbench.action.terminal.focus");
}

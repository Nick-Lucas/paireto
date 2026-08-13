// Workbench cleanup shared by the extension-host suites. Every test file runs in one window, so a
// test that ends with an unsaved buffer hands the next file a tab it cannot close: VS Code raises
// its own save dialog for a dirty tab, and nothing in a headless run answers it.

import * as vscode from "vscode";

/** Drop every unsaved change in the workbench. Reverting writes nothing to disk. */
export async function revertDirtyDocs(): Promise<void> {
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.isDirty && doc.uri.scheme === "file") {
      // Revert acts on the active editor, so the document has to hold it first.
      await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
      await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
    }
  }
}

// Shared commenting-range logic used by both the plan and review CommentControllers.
//
// IMPORTANT: returns a plain `vscode.Range[]` — the long-stable Comments API contract that released
// VS Code honors to render the gutter "+" affordance. The `{ enableFileComments, ranges }` object
// (CommentingRanges) is a proposed API and is silently ignored unless the extension runs with that
// proposal enabled, so we deliberately do NOT use it.

import * as vscode from "vscode";

/** A range spanning the whole document (every line is commentable). */
export function wholeDocumentRange(doc: vscode.TextDocument): vscode.Range[] {
  return [new vscode.Range(0, 0, Math.max(0, doc.lineCount - 1), 0)];
}

/** Allow commenting on every line of a document, but only for the given URI scheme. */
export function fullDocumentCommentingRanges(
  doc: vscode.TextDocument,
  scheme: string,
): vscode.Range[] | undefined {
  if (doc.uri.scheme !== scheme) {
    return undefined;
  }
  return wholeDocumentRange(doc);
}

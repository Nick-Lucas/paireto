// Serves one changeset's description as a read-only virtual markdown document under the
// paireto-changeset:// scheme, so a reviewer can read what a group of changes is for and comment on
// it at that level rather than on a line of code.
//
// A read-only FileSystemProvider, not a TextDocumentContentProvider: the latter leaves the document
// editable in the buffer (typing works; Save just offers "Save As"), and this document is a view of
// the agent's plan, never something to edit.

import * as vscode from "vscode";

import { Schemes } from "../config.js";
import type { GuidedChangesetState } from "./guidedPlan.js";

/** The visible tab name is the changeset title; the id rides in the query so two changesets that
 *  happen to share a title still get distinct URIs (mirrors how the plan document is keyed). */
export function changesetDocUri(changeset: { id: string; title: string }): vscode.Uri {
  return vscode.Uri.from({
    scheme: Schemes.changeset,
    path: `/${changeset.title.replaceAll("/", "-")}.md`,
    query: `id=${encodeURIComponent(changeset.id)}`,
  });
}

/** The changeset a document URI names, for routing a comment left on it back to its changeset. */
export function changesetIdFromDocUri(uri: vscode.Uri): string | undefined {
  if (uri.scheme !== Schemes.changeset) {
    return undefined;
  }
  const id = new URLSearchParams(uri.query).get("id");
  return id ?? undefined;
}

/** The markdown shown for a changeset: what it is, why, and the files in the agent's reading order. */
export function renderChangesetDoc(changeset: GuidedChangesetState): string {
  const lines = [`# ${changeset.title}`, ""];
  lines.push(changeset.description || "_The agent gave no description for this changeset._", "");
  lines.push("## Files, in reading order", "");
  for (const [index, row] of changeset.files.entries()) {
    const state = row.file ? `\`${row.file.group}\`` : "_no longer in the changes_";
    const note = row.note ? ` — ${row.note}` : "";
    lines.push(`${index + 1}. \`${row.path}\` · ${state}${note}`);
  }
  lines.push("", "---", "", "Comment on any line to give the agent feedback about this changeset.");
  return lines.join("\n");
}

export class ChangesetDocProvider implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;
  private readonly docs = new Map<string, Uint8Array>();

  set(uri: vscode.Uri, markdown: string): void {
    const key = uri.toString();
    const existed = this.docs.has(key);
    this.docs.set(key, new TextEncoder().encode(markdown));
    this.emitter.fire([
      {
        type: existed ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created,
        uri,
      },
    ]);
  }

  clear(): void {
    this.docs.clear();
  }

  readFile(uri: vscode.Uri): Uint8Array {
    const content = this.docs.get(uri.toString());
    if (!content) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return content;
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    const content = this.docs.get(uri.toString());
    if (!content) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: content.byteLength };
  }

  // The scheme holds one flat set of documents we mint ourselves, so the rest of the contract is
  // unreachable in practice; refusing loudly beats pretending to support it.
  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  createDirectory(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  writeFile(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  delete(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  rename(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  dispose(): void {
    this.emitter.dispose();
    this.docs.clear();
  }
}

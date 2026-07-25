// Serves base/modified file content for review diffs under the paireto-review:// scheme as a READ-ONLY
// FileSystemProvider. A read-only FS provider is what actually makes the virtual sides non-editable
// — a TextDocumentContentProvider doc placed on a diff's *modified* side stays editable-in-buffer
// (you can type; Save just prompts "Save As"). The URI shape is owned by ReviewPath; the `ref` it
// carries is resolved here to the right git blob, the index, the working-tree file, or empty.

import * as fs from "node:fs/promises";
import * as path from "node:path";

import * as vscode from "vscode";

import { gitSafeBytes } from "../git/gitCli.js";
import { ReviewPath } from "./ReviewPath.js";
import { Schemes } from "../config.js";

const EMPTY = new Uint8Array(0);

export class ReviewContentProvider implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;

  /** Last-resolved content per URI, so stat() + readFile() share one git call; cleared on change. */
  private readonly cache = new Map<string, Uint8Array>();
  /** Invalidation generation per URI; prevents a pre-refresh read finishing late into the cache. */
  private readonly generations = new Map<string, number>();

  // ── Refresh API (fires FileChangeEvents so open diffs re-read) ────────────────────────────────
  /** Force a refresh of any open diff editors backed by this URI. */
  refresh(uri: vscode.Uri): void {
    this.fire(uri);
  }

  /** Re-fetch all open virtual diff sides — used after any git state change to avoid stale blobs. */
  refreshAllOpen(): void {
    this.forEachOpenReviewUri((u) => this.fire(u));
  }

  private fire(uri: vscode.Uri): void {
    const key = uri.toString();
    this.cache.delete(key);
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  /** Walk open tabs, invoking `cb` for each paireto-review virtual URI (both sides of any diff). */
  private forEachOpenReviewUri(cb: (uri: vscode.Uri) => void): void {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        const uris =
          input instanceof vscode.TabInputTextDiff
            ? [input.original, input.modified]
            : input instanceof vscode.TabInputText
              ? [input.uri]
              : [];
        for (const u of uris) {
          if (u.scheme === Schemes.review) {
            cb(u);
          }
        }
      }
    }
  }

  // ── FileSystemProvider (read-only) ─────────────────────────────────────────────────────────────
  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined); // content is virtual; nothing to watch
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const content = await this.resolve(uri);
    return {
      type: vscode.FileType.File,
      ctime: 0,
      mtime: 0,
      size: content.byteLength,
      permissions: vscode.FilePermission.Readonly,
    };
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    return this.resolve(uri);
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  createDirectory(): void {
    throw vscode.FileSystemError.NoPermissions();
  }

  writeFile(): void {
    throw vscode.FileSystemError.NoPermissions();
  }

  delete(): void {
    throw vscode.FileSystemError.NoPermissions();
  }

  rename(): void {
    throw vscode.FileSystemError.NoPermissions();
  }

  /** Resolve a URI to its raw bytes, caching so a stat()+readFile() pair runs git only once. */
  private async resolve(uri: vscode.Uri): Promise<Uint8Array> {
    const key = uri.toString();
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const generation = this.generations.get(key) ?? 0;
    const bytes = await this.resolveContent(uri);
    // A refresh may have happened while git/fs was resolving. Return to the old caller, but never
    // let its stale result overwrite the cache used by the post-refresh editor read.
    if ((this.generations.get(key) ?? 0) === generation) {
      this.cache.set(key, bytes);
    }
    return bytes;
  }

  private async resolveContent(uri: vscode.Uri): Promise<Uint8Array> {
    const { ref, repoRoot, relPath } = ReviewPath.fromUri(uri);
    if (ref === "EMPTY" || !repoRoot || !relPath) {
      return EMPTY;
    }
    if (ref === "WORKING") {
      try {
        return await fs.readFile(path.join(repoRoot, relPath));
      } catch {
        return EMPTY;
      }
    }
    if (ref === "INDEX") {
      return gitSafeBytes(repoRoot, ["show", `:${relPath}`]);
    }
    return gitSafeBytes(repoRoot, ["show", `${ref}:${relPath}`]);
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

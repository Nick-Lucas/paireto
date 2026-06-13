// Minimal subset of the built-in `vscode.git` extension API (extensions/git/src/api/git.d.ts).
// We vendor only the members we consume rather than the full ~1k-line surface.

import type { Uri, Event } from "vscode";

export interface GitExtension {
  readonly enabled: boolean;
  getAPI(version: 1): API;
}

export interface API {
  readonly repositories: Repository[];
  readonly onDidOpenRepository: Event<Repository>;
  readonly onDidCloseRepository: Event<Repository>;
  getRepository(uri: Uri): Repository | null;
}

export interface RepositoryState {
  readonly HEAD: Branch | undefined;
  readonly onDidChange: Event<void>;
}

export interface Branch {
  readonly name?: string;
  readonly commit?: string;
  readonly upstream?: { readonly name: string; readonly remote: string };
}

export interface Repository {
  readonly rootUri: Uri;
  readonly state: RepositoryState;
}

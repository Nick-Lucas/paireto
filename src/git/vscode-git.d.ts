// Hand-authored, minimal subset of the built-in `vscode.git` extension's public API. These are the
// only members we consume; we declare them ourselves rather than depending on the full ~1k-line
// published surface. Structural typing means the real extension object satisfies these at runtime.

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

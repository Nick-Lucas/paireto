// Canonical, window-wide inventory of Git repositories and agent-addressable roots. VS Code's Git
// API is the discovery source for nested repositories, while each workspace folder's CLI toplevel is
// authoritative for its owning repository (notably for worktrees whose vscode.git root can be wrong).

import * as path from "node:path";

import * as vscode from "vscode";

import { canonicalize, isInside } from "../protocol/paths.js";
import { gitToplevel } from "./gitCli.js";
import type { RepoInfo, RepoService } from "./RepoService.js";

type RepositoryCatalogSource = Pick<RepoService, "repositories" | "onDidChangeRepositories">;

export interface WorkspaceRootCatalogEnvironment {
  workspaceFolders(): readonly vscode.WorkspaceFolder[];
  onDidChangeWorkspaceFolders: vscode.Event<vscode.WorkspaceFoldersChangeEvent>;
  gitToplevel(cwd: string): Promise<string | undefined>;
}

const DEFAULT_ENVIRONMENT: WorkspaceRootCatalogEnvironment = {
  workspaceFolders: () => vscode.workspace.workspaceFolders ?? [],
  onDidChangeWorkspaceFolders: vscode.workspace.onDidChangeWorkspaceFolders,
  gitToplevel,
};

export interface WorkspaceGitRoot {
  /** Canonical filesystem identity used for Git operations, sockets, and stable keys. */
  repoRoot: string;
  /** Concise path anchored on the owning VS Code workspace-folder name. */
  displayName: string;
  /** Owning workspace-folder index, used for deterministic multi-root ordering. */
  workspaceIndex: number;
}

interface FolderInfo {
  rawRoot: string;
  canonicalRoot: string;
  gitRoot?: string;
  index: number;
}

export interface WorkspaceRootIdentity {
  rawRoot: string;
  canonicalRoot: string;
  gitRoot?: string;
}

/**
 * Find the workspace folder that owns a vscode.git repository candidate. Matching the CLI root
 * admits an opened subdirectory's ancestor repo; containment admits nested repos/submodules. An
 * unrelated ancestor is deliberately excluded, which protects worktree windows from vscode.git's
 * occasional main-worktree root.
 */
export function relatedWorkspaceFolder<T extends WorkspaceRootIdentity>(
  rawRepoRoot: string,
  canonicalRepoRoot: string,
  folders: readonly T[],
): T | undefined {
  return folders.find(
    (folder) =>
      folder.gitRoot === canonicalRepoRoot ||
      isInside(folder.rawRoot, rawRepoRoot) ||
      isInside(folder.canonicalRoot, canonicalRepoRoot),
  );
}

/** Whether two root snapshots differ in topology or presentation. */
function rootsEqual(a: WorkspaceGitRoot[], b: WorkspaceGitRoot[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (root, index) =>
        root.repoRoot === b[index]?.repoRoot &&
        root.displayName === b[index]?.displayName &&
        root.workspaceIndex === b[index]?.workspaceIndex,
    )
  );
}

export class WorkspaceRootCatalog implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];
  private refreshSeq = 0;
  private gitRootState: WorkspaceGitRoot[] = [];
  private agentRootState: string[] = [];

  constructor(
    private readonly repos: RepositoryCatalogSource,
    private readonly environment: WorkspaceRootCatalogEnvironment = DEFAULT_ENVIRONMENT,
  ) {}

  async init(): Promise<void> {
    this.disposables.push(
      this.repos.onDidChangeRepositories(() => void this.refresh()),
      this.environment.onDidChangeWorkspaceFolders(() => void this.refresh()),
    );
    await this.refresh();
  }

  get gitRoots(): readonly WorkspaceGitRoot[] {
    return this.gitRootState;
  }

  get agentRoots(): readonly string[] {
    return this.agentRootState;
  }

  /** The longest detected Git root containing `target`, so nested repositories win. */
  gitRootForPath(target: string): WorkspaceGitRoot | undefined {
    const canonicalTarget = canonicalize(target);
    return this.gitRootState
      .filter((root) => isInside(root.repoRoot, canonicalTarget))
      .sort((a, b) => b.repoRoot.length - a.repoRoot.length)[0];
  }

  /** Rebuild the inventory; stale async scans are discarded by generation. */
  async refresh(): Promise<void> {
    const seq = ++this.refreshSeq;
    const folders = this.environment.workspaceFolders();
    const folderInfo: FolderInfo[] = await Promise.all(
      folders.map(async (folder, index) => {
        const rawRoot = folder.uri.fsPath;
        const top = await this.environment.gitToplevel(rawRoot);
        return {
          rawRoot,
          canonicalRoot: canonicalize(rawRoot),
          gitRoot: top ? canonicalize(top) : undefined,
          index,
        };
      }),
    );
    if (seq !== this.refreshSeq) {
      return;
    }

    const discovered = this.repos.repositories;
    const candidates = new Map<string, { root: string; owner: FolderInfo }>();
    const add = (root: string, owner: FolderInfo): void => {
      const canonical = canonicalize(root);
      const existing = candidates.get(canonical);
      if (!existing || owner.index < existing.owner.index) {
        candidates.set(canonical, { root: canonical, owner });
      }
    };

    // The CLI identity of each workspace folder is authoritative for the containing repo/worktree.
    for (const folder of folderInfo) {
      if (folder.gitRoot) {
        add(folder.gitRoot, folder);
      }
    }

    // vscode.git supplies nested repos/submodules. Only admit roots related to this workspace; an
    // ancestor that disagrees with the folder's CLI toplevel is the historical worktree false root.
    await Promise.all(
      discovered.map(async (repo: RepoInfo) => {
        const raw = repo.uri.fsPath;
        const canonical = canonicalize(raw);
        const owner = relatedWorkspaceFolder(raw, canonical, folderInfo);
        if (!owner) {
          return;
        }
        const verified = await this.environment.gitToplevel(raw);
        if (!verified || canonicalize(verified) !== canonical) {
          return;
        }
        add(canonical, owner);
      }),
    );
    if (seq !== this.refreshSeq) {
      return;
    }

    const gitRoots = [...candidates.values()]
      .map(({ root, owner }) => ({
        repoRoot: root,
        displayName: path.basename(root),
        workspaceIndex: owner.index,
      }))
      .sort(
        (a, b) =>
          a.workspaceIndex - b.workspaceIndex ||
          a.displayName.localeCompare(b.displayName) ||
          a.repoRoot.localeCompare(b.repoRoot),
      );

    // Raw workspace roots are intentional agent identities for non-Git folders. Git identities are
    // added alongside them; canonical dedupe collapses the common workspace-root-is-repo case.
    const agentRoots = [
      ...new Set([
        ...folderInfo.map((folder) => folder.canonicalRoot),
        ...gitRoots.map((root) => root.repoRoot),
      ]),
    ].sort();

    const changed =
      !rootsEqual(this.gitRootState, gitRoots) ||
      this.agentRootState.length !== agentRoots.length ||
      this.agentRootState.some((root, index) => root !== agentRoots[index]);
    this.gitRootState = gitRoots;
    this.agentRootState = agentRoots;
    if (changed) {
      this.emitter.fire();
    }
  }

  dispose(): void {
    this.refreshSeq += 1;
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.emitter.dispose();
  }
}

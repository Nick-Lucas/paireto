import type { FileStatus, NetChange } from "../git/DiffService.js";
import type { RepoChangedFile, RepositoryChangesModel } from "./ReviewController.js";

export type IndexWrite = "stage" | "unstage";

export function predictIndexWrite(
  changes: RepositoryChangesModel,
  paths: readonly string[],
  write: IndexWrite,
): RepositoryChangesModel {
  const staged = new Map(changes.staged.map((file) => [file.path, file]));
  const unstaged = new Map(changes.unstaged.map((file) => [file.path, file]));
  const netStatus = new Map<string, FileStatus>();
  for (const path of paths) {
    const s = staged.get(path);
    const u = unstaged.get(path);
    if (write === "stage" && u) {
      unstaged.delete(path);
      if (!s) {
        staged.set(path, { ...u, group: "staged", status: stagedStatus(u.status) });
      } else if (s.status === "A" && u.status === "D") {
        staged.delete(path);
      }
      if (u.status === "U") {
        netStatus.set(path, "A");
      }
    }
    if (write === "unstage" && s) {
      staged.delete(path);
      if (s.status === "A" && u?.status === "D") {
        unstaged.delete(path);
      } else if (s.status === "A") {
        unstaged.set(path, { ...(u ?? s), group: "unstaged", status: "U" });
        netStatus.set(path, "U");
      } else if (!u) {
        unstaged.set(path, { ...s, group: "unstaged" });
      }
    }
  }
  return {
    ...changes,
    staged: sortedByPath([...staged.values()]),
    unstaged: sortedByPath([...unstaged.values()]),
    net: changes.net.map((net): NetChange => {
      const status = netStatus.get(net.path);
      return status ? { ...net, status } : net;
    }),
  };
}

function stagedStatus(status: FileStatus): FileStatus {
  if (status === "U") {
    return "A";
  }
  return status === "!" ? "M" : status;
}

function sortedByPath(files: RepoChangedFile[]): RepoChangedFile[] {
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export class RepoWriteQueue {
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly pending = new Map<string, number>();

  isBusy(repoRoot: string): boolean {
    return (this.pending.get(repoRoot) ?? 0) > 0;
  }

  run(repoRoot: string, write: () => Promise<void>): Promise<void> {
    this.pending.set(repoRoot, (this.pending.get(repoRoot) ?? 0) + 1);
    const result = (this.tails.get(repoRoot) ?? Promise.resolve()).then(write).finally(() => {
      const left = (this.pending.get(repoRoot) ?? 1) - 1;
      if (left === 0) {
        this.pending.delete(repoRoot);
        this.tails.delete(repoRoot);
      } else {
        this.pending.set(repoRoot, left);
      }
    });
    this.tails.set(
      repoRoot,
      result.catch(() => undefined),
    );
    return result;
  }
}

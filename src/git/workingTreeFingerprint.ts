import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { git, gitSafe, gitToplevel, splitNul } from "./gitCli.js";

/** Enough workers to keep the disk busy on a tree with thousands of changed paths, without opening
 *  a file handle per path at once. */
const CONCURRENCY = 16;

export async function workingTreeFingerprint(root: string): Promise<string> {
  const head = (await gitSafe(root, ["rev-parse", "--verify", "HEAD"])).trim();
  const [physicalRoot, tracked, untracked] = await Promise.all([
    fs.realpath(root),
    git(
      root,
      head
        ? ["diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", head, "--"]
        : ["ls-files", "--cached", "-z"],
    ),
    git(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const files = [...new Set(splitNul(tracked.stdout + untracked.stdout))].sort();
  const stamps = await mapLimited(files, (file) => entryStamp(physicalRoot, path.join(root, file)));
  const hash = createHash("sha256").update(head);
  // Folded in the listing's sorted order, so the result does not depend on which stamp landed first.
  files.forEach((file, index) => hash.update(JSON.stringify([file, stamps[index]])));
  return hash.digest("hex");
}

/**
 * What one path looks like now, from its stat data alone. A write always moves the modification time
 * or the size, and an agent's turn lasts far longer than the coarsest timestamp a filesystem keeps,
 * so this answers "did it change?" without opening the file. The trade: a rewrite with the same bytes
 * counts as a change. Modification time and size only — a file's change time also moves when just its
 * metadata is written (macOS extended attributes, say), which is not a change to the turn.
 *
 * Every failure becomes a stamp of its own instead of aborting: a snapshot that throws leaves the
 * turn-end gate with nothing to compare, and it would then allow every later Stop with no review.
 */
async function entryStamp(physicalRoot: string, absolute: string): Promise<string> {
  try {
    const stat = await fs.lstat(absolute, { bigint: true });
    if (stat.isSymbolicLink()) {
      return `link:${stat.mode}:${await fs.readlink(absolute)}:${await linkTargetStamp(physicalRoot, absolute)}`;
    }
    if (stat.isFile()) {
      return `file:${stat.mode}:${stat.size}:${stat.mtimeNs}`;
    }
    if (stat.isDirectory()) {
      return `dir:${stat.mode}:${await nestedRepositoryFingerprint(absolute)}`;
    }
    // A pipe, socket or device: it has no content of its own to describe.
    return `other:${stat.mode}`;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? "deleted" : `unreadable:${code ?? "unknown"}`;
  }
}

/**
 * What a symlink points at, when that is inside this repository — so an edit to the target counts as
 * a change even when Git never lists the target itself (an ignored file, say). A target outside the
 * repository is left alone: nothing out there can appear in the review, so a change to it is not this
 * turn's business.
 */
async function linkTargetStamp(physicalRoot: string, absolute: string): Promise<string> {
  try {
    // realpath, not readlink: it follows a chain of links, so only the path the reader really lands
    // on decides whether the target is inside the repository.
    const physical = await fs.realpath(absolute);
    if (physical !== physicalRoot && !physical.startsWith(physicalRoot + path.sep)) {
      return "outside";
    }
    const stat = await fs.stat(physical, { bigint: true });
    return stat.isFile()
      ? `${stat.mode}:${stat.size}:${stat.mtimeNs}`
      : `${stat.mode}:${stat.mtimeNs}`;
  } catch (error) {
    return `unreachable:${(error as NodeJS.ErrnoException).code ?? "unknown"}`;
  }
}

/**
 * A submodule's own working tree, which is where its changes live: the parent repository names only
 * the directory, and that entry stays equal for every further edit once the submodule is dirty. Any
 * other directory (a tracked path replaced by one, say) is described by its mode alone.
 */
async function nestedRepositoryFingerprint(absolute: string): Promise<string> {
  const [toplevel, physical] = await Promise.all([gitToplevel(absolute), fs.realpath(absolute)]);
  return toplevel && path.resolve(toplevel) === physical
    ? await workingTreeFingerprint(absolute)
    : "";
}

/** Run `fn` over `items`, at most CONCURRENCY at a time, keeping the results in the input's order. */
async function mapLimited<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let index = next++; index < items.length; index = next++) {
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  return results;
}

// The "Compare To" QuickPick: choose the point the Committed group is diffed against.
// Presets: HEAD, merge-base, stack base, the auto-detected default branch, and a Branch/Ref… picker.

import * as vscode from "vscode";

import type { DiffService } from "../git/DiffService.js";
import type { CompareTo } from "../types.js";

export type FileCompareTo = CompareTo | { kind: "index" } | { kind: "empty" };

interface CompareItem<T = CompareTo> extends vscode.QuickPickItem {
  value?: T;
  pickRef?: boolean;
  /** Concrete provider token used to match a tab-local comparison. */
  comparisonRef?: string;
}

export async function pickCompareTo(
  repoRoot: string,
  diff: DiffService,
  recentRefs: string[],
  current: CompareTo,
): Promise<CompareTo | undefined> {
  const defaultBranch = await diff.defaultBranch(repoRoot);
  const items: CompareItem[] = [
    { label: "$(git-commit) HEAD", description: "working changes only", value: { kind: "head" } },
    {
      label: "$(git-pull-request) Merge base",
      description: "since the default branch",
      value: { kind: "mergeBase" },
    },
    {
      label: "$(layers) Stack base",
      description: "since the branch below in the stack",
      value: { kind: "stackBase" },
    },
  ];
  if (defaultBranch) {
    items.push({
      label: `$(git-branch) ${defaultBranch}`,
      description: "default branch",
      value: { kind: "default" },
    });
  }
  if (current.kind === "ref" && current.ref && !recentRefs.includes(current.ref)) {
    items.push({
      label: `$(history) ${current.ref}`,
      description: "current comparison",
      value: current,
    });
  }
  items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
  items.push({
    label: "$(git-branch) Branch/Ref…",
    description: "pick any branch or ref",
    pickRef: true,
  });

  const choice = await showComparePicker(
    items,
    "Compare To",
    (item) => item.value !== undefined && compareToEqual(item.value, current),
  );
  if (!choice) {
    return undefined;
  }
  if (choice.pickRef) {
    return pickRef(repoRoot, diff, recentRefs, current.kind === "ref" ? current.ref : undefined);
  }
  return choice.value;
}

/** Multi-repository comparison is deliberately semantic: every repo resolves the same preset using
 * its own default branch/merge-base, so unrelated branch names are never applied across repos. */
export async function pickMultiCompareTo(current: CompareTo): Promise<CompareTo | undefined> {
  const normalized = current.kind === "ref" ? ({ kind: "default" } as CompareTo) : current;
  const items: CompareItem[] = [
    { label: "$(git-commit) HEAD", description: "working changes only", value: { kind: "head" } },
    {
      label: "$(git-pull-request) Merge base",
      description: "resolve independently per repository",
      value: { kind: "mergeBase" },
    },
    {
      label: "$(layers) Stack base",
      description: "resolve independently per repository",
      value: { kind: "stackBase" },
    },
    {
      label: "$(git-branch) Default branch",
      description: "main/master/origin HEAD per repository",
      value: { kind: "default" },
    },
  ];
  const choice = await showComparePicker(
    items,
    "Compare All Repositories To",
    (item) => item.value !== undefined && compareToEqual(item.value, normalized),
  );
  return choice?.value;
}

/** The tab-local picker also exposes the index, which is the natural base of Working Tree diffs. */
export async function pickFileCompareTo(
  repoRoot: string,
  diff: DiffService,
  recentRefs: string[],
  currentBaseRef: string,
  currentBaseLabel?: string,
): Promise<FileCompareTo | undefined> {
  const [defaultBranch, mergeBase, stackBase] = await Promise.all([
    diff.defaultBranch(repoRoot),
    diff.resolveCompareTo(repoRoot, { kind: "mergeBase" }),
    diff.resolveCompareTo(repoRoot, { kind: "stackBase" }),
  ]);
  const items: CompareItem<FileCompareTo>[] = [];
  if (currentBaseRef === "EMPTY") {
    items.push({
      label: "$(circle-slash) Empty",
      description: "empty file",
      value: { kind: "empty" },
      comparisonRef: "EMPTY",
    });
  }
  items.push(
    {
      label: "$(list-unordered) Index",
      description: "staged content",
      value: { kind: "index" },
      comparisonRef: "INDEX",
    },
    {
      label: "$(git-commit) HEAD",
      description: "latest commit",
      value: { kind: "head" },
      comparisonRef: "HEAD",
    },
    {
      label: "$(git-pull-request) Merge base",
      description: "where this branch diverged",
      value: { kind: "mergeBase" },
      comparisonRef: mergeBase.ref ?? "HEAD",
    },
    {
      label: "$(layers) Stack base",
      description: "where this branch was created",
      value: { kind: "stackBase" },
      comparisonRef: stackBase.ref ?? "HEAD",
    },
  );
  if (defaultBranch) {
    items.push({
      label: `$(git-branch) ${defaultBranch}`,
      description: "default branch",
      value: { kind: "default" },
      comparisonRef: defaultBranch,
    });
  }
  const currentKind = currentFileCompareKind(currentBaseRef, currentBaseLabel, defaultBranch);
  const matchingPreset = items.some(
    (item) => item.comparisonRef === currentBaseRef && item.value?.kind === currentKind,
  );
  if (!matchingPreset && !recentRefs.includes(currentBaseRef)) {
    items.push({
      label: `$(git-compare) ${currentBaseLabel ?? currentBaseRef}`,
      description: "current comparison",
      value: { kind: "ref", ref: currentBaseRef },
      comparisonRef: currentBaseRef,
    });
  }
  items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
  items.push({
    label: "$(git-branch) Branch/Ref…",
    description: "pick any branch or ref",
    pickRef: true,
  });

  const choice = await showComparePicker(
    items,
    "Compare This File To",
    (item) =>
      item.comparisonRef === currentBaseRef &&
      (currentKind === undefined || item.value?.kind === currentKind),
  );
  if (!choice) {
    return undefined;
  }
  if (choice.pickRef) {
    const currentRef = ["EMPTY", "INDEX", "HEAD", "WORKING"].includes(currentBaseRef)
      ? undefined
      : currentBaseRef;
    return pickRef(repoRoot, diff, recentRefs, currentRef);
  }
  return choice.value;
}

async function pickRef(
  repoRoot: string,
  diff: DiffService,
  recentRefs: string[],
  currentRef?: string,
): Promise<CompareTo | undefined> {
  const items = recentRefs.map((ref) => ({ label: `$(history) ${ref}`, ref }));
  const picked = await showRefPicker(items, currentRef, (query) =>
    Promise.all([diff.searchRefs(repoRoot, query), diff.refExists(repoRoot, query)]),
  );
  return picked ? { kind: "ref", ref: picked.ref } : undefined;
}

export function compareToEqual(a: CompareTo, b: CompareTo): boolean {
  return a.kind === b.kind && (a.kind !== "ref" || a.ref === b.ref);
}

/** Recover the most specific picker row from a tab's concrete ref plus its presentation label. */
export function currentFileCompareKind(
  baseRef: string,
  baseLabel: string | undefined,
  defaultBranch: string | undefined,
): FileCompareTo["kind"] | undefined {
  // A stack base can resolve to the same commit as the merge base, so the label is the only thing
  // that keeps the two rows apart.
  if (baseLabel?.startsWith("stack-base(")) {
    return "stackBase";
  }
  if (baseLabel?.startsWith("merge-base(")) {
    return "mergeBase";
  }
  if (defaultBranch && baseRef === defaultBranch && baseLabel === defaultBranch) {
    return "default";
  }
  if (baseRef === "EMPTY") {
    return "empty";
  }
  if (baseRef === "INDEX") {
    return "index";
  }
  if (baseRef === "HEAD") {
    return "head";
  }
  if (baseRef !== "WORKING") {
    return "ref";
  }
  return undefined;
}

/** Single-select QuickPick with a genuinely active initial row (QuickPickItem.picked is multi-only). */
async function showComparePicker<T extends vscode.QuickPickItem>(
  items: T[],
  title: string,
  isCurrent: (item: T) => boolean,
): Promise<T | undefined> {
  const picker = vscode.window.createQuickPick<T>();
  picker.title = title;
  picker.items = items;
  const current = items.find(
    (item) => item.kind !== vscode.QuickPickItemKind.Separator && isCurrent(item),
  );
  if (current) {
    picker.activeItems = [current];
  }

  return new Promise<T | undefined>((resolve) => {
    let settled = false;
    const finish = (choice?: T): void => {
      if (settled) {
        return;
      }
      settled = true;
      accept.dispose();
      hide.dispose();
      picker.dispose();
      resolve(choice);
    };
    const accept = picker.onDidAccept(() =>
      finish(picker.activeItems[0] ?? picker.selectedItems[0]),
    );
    const hide = picker.onDidHide(() => finish());
    picker.show();
  });
}

interface RefItem extends vscode.QuickPickItem {
  ref: string;
}

async function showRefPicker(
  items: RefItem[],
  currentRef: string | undefined,
  search: (query: string) => Promise<[matches: string[], exact: boolean]>,
): Promise<RefItem | undefined> {
  const picker = vscode.window.createQuickPick<RefItem>();
  picker.title = "Compare To: branch / ref";
  picker.items = items;
  const current = items.find((item) => item.ref === currentRef);
  if (current) {
    picker.activeItems = [current];
  }

  return new Promise<RefItem | undefined>((resolve) => {
    let settled = false;
    let searchSequence = 0;
    let visibleItems = items;
    const finish = (choice?: RefItem): void => {
      if (settled) {
        return;
      }
      settled = true;
      accept.dispose();
      change.dispose();
      hide.dispose();
      picker.dispose();
      resolve(choice);
    };
    const accept = picker.onDidAccept(() => {
      const entered = picker.value.trim();
      const matched = entered ? visibleItems.find((item) => item.ref === entered) : undefined;
      const choice = entered
        ? (matched ?? visibleItems[0])
        : (picker.activeItems[0] ?? picker.selectedItems[0]);
      if (choice) {
        finish(choice);
      }
    });
    const change = picker.onDidChangeValue(async (value) => {
      const ref = value.trim();
      if (!ref) {
        searchSequence += 1;
        picker.busy = false;
        visibleItems = items;
        picker.items = items;
        picker.activeItems = current ? [current] : [];
        return;
      }
      const sequence = ++searchSequence;
      picker.busy = true;
      const [matches, exact] = await search(ref);
      if (settled || sequence !== searchSequence) {
        return;
      }
      const found = matches.map((match) => ({ label: match, ref: match }));
      if (exact && !matches.includes(ref)) {
        found.unshift({ label: ref, ref });
      }
      visibleItems = found;
      picker.items = found;
      picker.activeItems = found.length ? [found[0]] : [];
      picker.busy = false;
    });
    const hide = picker.onDidHide(() => finish());
    picker.show();
  });
}

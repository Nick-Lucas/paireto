// The "Compare To" QuickPick: choose the point the Committed group is diffed against.
// Presets: HEAD, merge-base, the auto-detected default branch, up to 3 recent refs, and a
// Branch/Ref… picker (whose choice is added to the recents).

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
      description: "since you branched",
      value: { kind: "mergeBase" },
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
  if (recentRefs.length) {
    items.push({ label: "Recent", kind: vscode.QuickPickItemKind.Separator });
    for (const ref of recentRefs) {
      items.push({ label: `$(history) ${ref}`, value: { kind: "ref", ref } });
    }
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
    return pickRef(repoRoot, diff, current.kind === "ref" ? current.ref : undefined);
  }
  return choice.value;
}

/** The tab-local picker also exposes the index, which is the natural base of Working Tree diffs. */
export async function pickFileCompareTo(
  repoRoot: string,
  diff: DiffService,
  recentRefs: string[],
  currentBaseRef: string,
  currentBaseLabel?: string,
): Promise<FileCompareTo | undefined> {
  const defaultBranch = await diff.defaultBranch(repoRoot);
  const mergeBase = await diff.resolveCompareTo(repoRoot, { kind: "mergeBase" });
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
  if (recentRefs.length) {
    items.push({ label: "Recent", kind: vscode.QuickPickItemKind.Separator });
    for (const ref of recentRefs) {
      items.push({
        label: `$(history) ${ref}`,
        value: { kind: "ref", ref },
        comparisonRef: ref,
      });
    }
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
    return pickRef(repoRoot, diff, currentRef);
  }
  return choice.value;
}

async function pickRef(
  repoRoot: string,
  diff: DiffService,
  currentRef?: string,
): Promise<CompareTo | undefined> {
  const refs = await diff.listRefs(repoRoot);
  const items = refs.map((ref) => ({ label: ref, ref }));
  const picked = await showComparePicker(
    items,
    "Compare To: branch / ref",
    (item) => item.ref === currentRef,
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
      finish(picker.selectedItems[0] ?? picker.activeItems[0]),
    );
    const hide = picker.onDidHide(() => finish());
    picker.show();
  });
}

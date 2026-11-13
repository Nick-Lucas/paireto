import type { SourceSpan } from "./model.js";

export interface LineDiff {
  added: ReadonlySet<number>;
  removed: ReadonlySet<number>;
}

const MAX_EDIT_DISTANCE = 2000;

export function splitLines(text: string): string[] {
  if (text === "") {
    return [];
  }
  const lines = text.split(/\r\n|\r|\n/);
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

export function diffLines(base: readonly string[], modified: readonly string[]): LineDiff {
  let start = 0;
  while (start < base.length && start < modified.length && base[start] === modified[start]) {
    start++;
  }
  let baseEnd = base.length;
  let modifiedEnd = modified.length;
  while (
    baseEnd > start &&
    modifiedEnd > start &&
    base[baseEnd - 1] === modified[modifiedEnd - 1]
  ) {
    baseEnd--;
    modifiedEnd--;
  }
  const added = new Set<number>();
  const removed = new Set<number>();
  const a = base.slice(start, baseEnd);
  const b = modified.slice(start, modifiedEnd);
  const script = myers(a, b);
  if (!script) {
    for (let i = start; i < baseEnd; i++) {
      removed.add(i);
    }
    for (let j = start; j < modifiedEnd; j++) {
      added.add(j);
    }
    return { added, removed };
  }
  for (const i of script.removed) {
    removed.add(i + start);
  }
  for (const j of script.added) {
    added.add(j + start);
  }
  return { added, removed };
}

function myers(
  a: readonly string[],
  b: readonly string[],
): { added: number[]; removed: number[] } | undefined {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) {
    return {
      added: Array.from({ length: m }, (_, j) => j),
      removed: Array.from({ length: n }, (_, i) => i),
    };
  }
  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    const next = v.slice();
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1];
      } else {
        x = v[offset + k - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      next[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    v = next;
    if (found >= 0) {
      break;
    }
  }
  if (found < 0) {
    return undefined;
  }
  const added: number[] = [];
  const removed: number[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d];
    const at = (diagonal: number): number => prev[diagonal + d + 1];
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && at(k - 1) < at(k + 1))) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
    }
    if (x === prevX) {
      y--;
      added.push(y);
    } else {
      x--;
      removed.push(x);
    }
  }
  return { added: added.reverse(), removed: removed.reverse() };
}

export function countInRange(lines: ReadonlySet<number>, start: number, end: number): number {
  let count = 0;
  if (lines.size < end - start + 1) {
    for (const line of lines) {
      if (line >= start && line <= end) {
        count++;
      }
    }
    return count;
  }
  for (let line = start; line <= end; line++) {
    if (lines.has(line)) {
      count++;
    }
  }
  return count;
}

function lastOf(lines: ReadonlySet<number>): number {
  let last = -1;
  for (const line of lines) {
    last = Math.max(last, line);
  }
  return last;
}

export function diffHunks(diff: LineDiff): SourceSpan[] {
  const lastBase = lastOf(diff.removed);
  const lastModified = lastOf(diff.added);
  const hunks: SourceSpan[] = [];
  let i = 0;
  let j = 0;
  while (i <= lastBase || j <= lastModified) {
    if (!diff.removed.has(i) && !diff.added.has(j)) {
      i++;
      j++;
      continue;
    }
    const baseStart = i;
    const modifiedStart = j;
    while (diff.removed.has(i) || diff.added.has(j)) {
      if (diff.removed.has(i)) {
        i++;
      } else {
        j++;
      }
    }
    hunks.push(
      j > modifiedStart
        ? { side: "modified", start: modifiedStart, end: j - 1 }
        : { side: "base", start: baseStart, end: i - 1 },
    );
  }
  return hunks;
}

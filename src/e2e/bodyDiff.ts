// A readable diff between the request a replay sent and the cassette entry it should have matched.
//
// A strict-VCR miss is almost always a small substitution inside a large body — one id, one changed
// count — so the useful output is the differing lines, not the body, a digest, or MockServer's
// rendering of the whole unmatched request.

/** Lines of leading/trailing context kept around each differing hunk. */
const CONTEXT_LINES = 2;
/** How far ahead to look for a resync point before treating the rest as one hunk. */
const RESYNC_WINDOW = 40;
/** Cap on emitted lines, so one structural change cannot bury the terminal. */
const MAX_LINES = 60;

export interface DiffHunk {
  /** 1-based line number in the cassette body where the hunk starts. */
  line: number;
  expected: string[];
  actual: string[];
}

/** Pretty-print JSON so the diff lands on semantic lines; non-JSON is diffed as-is. */
export function toDiffLines(body: string): string[] {
  try {
    return JSON.stringify(JSON.parse(body), null, 2).split("\n");
  } catch {
    return body.split("\n");
  }
}

/**
 * Line hunks where the two bodies differ. Two pointers walk in step; on a mismatch each side is
 * scanned for the nearest line that lets them resync, which keeps an inserted or deleted block from
 * reporting everything after it as changed.
 */
export function diffHunks(expected: readonly string[], actual: readonly string[]): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let i = 0;
  let j = 0;
  while (i < expected.length || j < actual.length) {
    if (i < expected.length && j < actual.length && expected[i] === actual[j]) {
      i += 1;
      j += 1;
      continue;
    }
    const resync = findResync(expected, actual, i, j);
    hunks.push({
      line: i + 1,
      expected: expected.slice(i, resync.i),
      actual: actual.slice(j, resync.j),
    });
    i = resync.i;
    j = resync.j;
  }
  return hunks;
}

/** The nearest pair of positions where both sides line up again. */
function findResync(
  expected: readonly string[],
  actual: readonly string[],
  from: number,
  to: number,
): { i: number; j: number } {
  for (let offset = 1; offset <= RESYNC_WINDOW; offset += 1) {
    for (let back = 0; back <= offset; back += 1) {
      const i = from + offset - back;
      const j = to + back;
      if (i < expected.length && j < actual.length && expected[i] === actual[j]) {
        return { i, j };
      }
    }
  }
  return { i: expected.length, j: actual.length };
}

/**
 * The miss rendered for a terminal: the differing lines with a little context, capped. `expected` is
 * the cassette's match key, `actual` what the replayed run sent.
 */
export function describeBodyDiff(expected: string, actual: string): string {
  const expectedLines = toDiffLines(expected);
  const actualLines = toDiffLines(actual);
  const hunks = diffHunks(expectedLines, actualLines);
  if (hunks.length === 0) {
    return "(bodies are identical — the miss is in the method or path)";
  }
  const out: string[] = ["--- cassette", "+++ replayed request"];
  let emitted = 0;
  let shown = 0;
  for (const hunk of hunks) {
    const budget = MAX_LINES - emitted;
    if (budget <= 0) {
      break;
    }
    const before = expectedLines.slice(Math.max(0, hunk.line - 1 - CONTEXT_LINES), hunk.line - 1);
    out.push(`@@ line ${hunk.line} @@`);
    out.push(...before.map((line) => ` ${line}`));
    const body = [
      ...hunk.expected.map((line) => `-${line}`),
      ...hunk.actual.map((line) => `+${line}`),
    ];
    out.push(...body.slice(0, budget).map(truncate));
    if (body.length > budget) {
      out.push(`  … ${body.length - budget} more changed lines`);
    }
    emitted += Math.min(body.length, budget);
    shown += 1;
  }
  if (shown < hunks.length) {
    out.push(`  … ${hunks.length - shown} more differing hunks`);
  }
  return out.join("\n");
}

/** Keep a single very long line (a whole prompt on one line) from wrapping off the screen. */
function truncate(line: string): string {
  return line.length > 240 ? `${line.slice(0, 240)}… (+${line.length - 240} chars)` : line;
}

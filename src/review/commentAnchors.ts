// Pure relocation logic for durable review-comment anchors. Comments keep their original quote and
// nearby context; when the backing document changes, this chooses the best current line without ever
// dropping the comment merely because an exact match disappeared.

import type { ReviewAnchor } from "./reviewTypes.js";

export function relocateReviewAnchor(
  lines: string[],
  previousLine: number,
  anchor: ReviewAnchor,
): number {
  if (lines.length === 0) {
    return 0;
  }
  const hint = clamp(previousLine, 0, lines.length - 1);
  const exact = candidateLines(lines, anchor.lineText);
  const candidates = exact.length > 0 ? exact : lines.map((_, i) => i);

  let best = hint;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const line of candidates) {
    const textScore = lineMatches(lines[line], anchor.lineText) ? 20 : 0;
    const contextScore = scoreContext(lines, line, anchor);
    // Context dominates distance, which is only a deterministic tie-breaker among equal matches.
    const score = textScore + contextScore - Math.abs(line - hint) / (lines.length + 1);
    if (score > bestScore) {
      best = line;
      bestScore = score;
    }
  }

  // With neither quote nor context left, the old line (safely clamped) is the least surprising home.
  if (exact.length === 0 && scoreContext(lines, best, anchor) === 0) {
    return hint;
  }
  return best;
}

function candidateLines(lines: string[], expected: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lineMatches(lines[i], expected)) {
      out.push(i);
    }
  }
  return out;
}

function scoreContext(lines: string[], line: number, anchor: ReviewAnchor): number {
  let score = 0;
  for (let offset = 1; offset <= anchor.contextBefore.length; offset++) {
    const expected = anchor.contextBefore[anchor.contextBefore.length - offset];
    if (line - offset >= 0 && lineMatches(lines[line - offset], expected)) {
      score += 5;
    }
  }
  for (let offset = 1; offset <= anchor.contextAfter.length; offset++) {
    const expected = anchor.contextAfter[offset - 1];
    if (line + offset < lines.length && lineMatches(lines[line + offset], expected)) {
      score += 5;
    }
  }
  return score;
}

function lineMatches(actual: string, expected: string): boolean {
  return actual === expected || actual.trim() === expected.trim();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

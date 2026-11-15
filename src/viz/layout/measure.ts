import { estimateTextWidth } from "./geometry.js";

export type FontRole = "title" | "code" | "small" | "smallBold";

export type Measure = (text: string, role: FontRole) => number;

export const FONT_SIZES: Record<FontRole, number> = {
  title: 13,
  code: 12,
  small: 11,
  smallBold: 11,
};

export const estimateMeasure: Measure = (text, role) =>
  estimateTextWidth(text, FONT_SIZES[role]) + 1;

export function fitText(text: string, role: FontRole, maxWidth: number, measure: Measure): string {
  if (measure(text, role) <= maxWidth) {
    return text;
  }
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (measure(`${text.slice(0, mid)}…`, role) <= maxWidth) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return `${text.slice(0, low)}…`;
}

export function wrapText(
  text: string,
  role: FontRole,
  maxWidth: number,
  measure: Measure,
  maxLines: number,
): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (measure(next, role) <= maxWidth) {
      line = next;
    } else if (line) {
      lines.push(line);
      line = fitText(word, role, maxWidth, measure);
    } else {
      lines.push(fitText(word, role, maxWidth, measure));
    }
  }
  if (line) {
    lines.push(line);
  }
  if (lines.length <= maxLines) {
    return lines;
  }
  const rest = lines.slice(maxLines - 1).join(" ");
  return [...lines.slice(0, maxLines - 1), fitText(`${rest} …`, role, maxWidth, measure)];
}

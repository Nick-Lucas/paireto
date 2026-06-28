// Builds the human-readable label for a plan's virtual-document tab: `PLAN: <first line> - <when>`.
// Kept pure (no vscode import) so it's unit-testable; the datetime is passed in for the same reason.

const MAX_TITLE = 60;

/** Strip leading markdown markers (heading/quote/list/bold/backtick) and surrounding whitespace. */
function firstMeaningfulLine(plan: string): string {
  for (const raw of plan.split("\n")) {
    const stripped = raw
      .replace(/^[\s>#*\-`]+/, "") // leading markdown markers + whitespace
      .replace(/[/\\]/g, " ") // keep it a single path segment
      .trim();
    if (stripped) {
      return stripped.length > MAX_TITLE ? `${stripped.slice(0, MAX_TITLE - 1)}…` : stripped;
    }
  }
  return "Plan";
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** `YYYY-MM-DD HH:mm` in local time — deterministic (no locale) so callers/tests are stable. */
function formatDateTime(date: Date): string {
  const d = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const t = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return `${d} ${t}`;
}

export function planDocLabel(plan: string, date: Date): string {
  return `PLAN: ${firstMeaningfulLine(plan)} - ${formatDateTime(date)}`;
}

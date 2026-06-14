// Comment "kind" taxonomy shared by plan + code review. Replaces the old severity model.
// Pure module (no vscode import) so the feedback serializers stay unit-testable in plain node;
// the codicon id / theme-color id are returned as strings for the view layer to wrap.

export type CommentKind = "question" | "comment" | "problem";

export const COMMENT_KINDS: readonly CommentKind[] = ["question", "comment", "problem"];

export const DEFAULT_KIND: CommentKind = "comment";

const LABELS: Record<CommentKind, string> = {
  question: "Question",
  comment: "Comment",
  problem: "Problem",
};

const ICONS: Record<CommentKind, string> = {
  question: "question",
  comment: "comment",
  problem: "error",
};

const COLOR_IDS: Record<CommentKind, string | undefined> = {
  question: "charts.blue",
  comment: undefined,
  problem: "list.errorForeground",
};

/** Sort/priority: problems first, then questions, then plain comments. */
export const KIND_RANK: Record<CommentKind, number> = { problem: 0, question: 1, comment: 2 };

export function kindLabel(kind: CommentKind): string {
  return LABELS[kind];
}

export function kindIcon(kind: CommentKind): string {
  return ICONS[kind];
}

export function kindColorId(kind: CommentKind): string | undefined {
  return COLOR_IDS[kind];
}

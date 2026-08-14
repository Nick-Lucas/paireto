// Comment "kind" taxonomy shared by plan + code review. Replaces the old severity model.
// Pure module (no vscode import) so the feedback serializers stay unit-testable in plain node;
// the codicon id / theme-color id are returned as strings for the view layer to wrap.

export type CommentKind = "question" | "comment";

export const COMMENT_KINDS: readonly CommentKind[] = ["question", "comment"];

export const DEFAULT_KIND: CommentKind = "comment";

const LABELS: Record<CommentKind, string> = {
  question: "Question",
  comment: "Comment",
};

const ICONS: Record<CommentKind, string> = {
  question: "question",
  comment: "comment",
};

const COLOR_IDS: Record<CommentKind, string | undefined> = {
  question: "charts.blue",
  comment: undefined,
};

/** Sort/priority: questions first, then plain comments. */
export const KIND_RANK: Record<CommentKind, number> = { question: 0, comment: 1 };

export function kindLabel(kind: CommentKind): string {
  return LABELS[kind];
}

export function kindIcon(kind: CommentKind): string {
  return ICONS[kind];
}

export function kindColorId(kind: CommentKind): string | undefined {
  return COLOR_IDS[kind];
}

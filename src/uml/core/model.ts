export type DiffSide = "base" | "modified";

export interface LineCounts {
  added: number;
  removed: number;
}

export interface SourceSpan {
  side: DiffSide;
  start: number;
  end: number;
}

export type TypeKind = "class" | "interface" | "enum" | "struct" | "module" | "file";

export type TypeChange = "added" | "removed" | "modified" | "unchanged";

export type MemberChange = "added" | "removed" | "signature" | "body" | "unchanged";

export type Compartment = "field" | "method";

export type Visibility = "+" | "-" | "#" | "~";

export interface UmlMember {
  id: string;
  name: string;
  compartment: Compartment;
  visibility?: Visibility;
  isStatic: boolean;
  isAbstract: boolean;
  label: string;
  short: string;
  previousLabel?: string;
  change: MemberChange;
  counts: LineCounts;
  span: SourceSpan;
  openThreads: number;
}

export interface UmlType {
  id: string;
  name: string;
  kind: TypeKind;
  isAbstract: boolean;
  fileKey: string;
  change: TypeChange;
  headerChanged: boolean;
  counts: LineCounts;
  members: UmlMember[];
  span?: SourceSpan;
  context: boolean;
  openThreads: number;
}

export interface UmlFile {
  key: string;
  repoRoot: string;
  repoName: string;
  path: string;
  status: string;
  counts: LineCounts;
  read: boolean;
  openThreads: number;
  hasOutline: boolean;
  changes: SourceSpan[];
}

export type RelationKind = "generalization" | "realization" | "association" | "dependency";

export type RelationChange = "added" | "removed" | "unchanged";

export interface UmlRelation {
  id: string;
  kind: RelationKind;
  source: string;
  target: string;
  multiplicity?: string;
  change: RelationChange;
  via: string[];
  roles: string[];
}

export type CommentScope = "type" | "member" | "group" | "file";

export interface UmlCommentLink {
  scope: CommentScope;
  title: string;
  typeIds: string[];
  memberId?: string;
  fileKey?: string;
}

export interface NotePlace {
  typeId?: string;
  x: number;
  y: number;
}

export interface UmlCommentItem {
  id: string;
  sent: boolean;
  who: "you" | "agent";
  body: string;
  at: string;
}

export interface UmlComment {
  id: string;
  kind: "question" | "comment";
  body: string;
  replies: number;
  sent: boolean;
  items: UmlCommentItem[];
  unread: number;
  waiting: boolean;
  links: UmlCommentLink[];
  place?: NotePlace;
}

export interface UmlModel {
  comparison: string;
  repoCount: number;
  files: UmlFile[];
  types: UmlType[];
  relations: UmlRelation[];
  comments: UmlComment[];
  notes: string[];
}

export function changeSize(counts: LineCounts): number {
  return counts.added + counts.removed;
}

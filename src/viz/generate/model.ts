import type { VizMemberKind } from "../../protocol/viz.js";
import type { VizFileStatus } from "../protocol.js";

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

export type TypeKind = "class" | "interface" | "enum" | "struct" | "module";

export type ContextKind = Exclude<TypeKind, "module">;

export type TypeChange = "added" | "removed" | "modified" | "unchanged";

export type MemberChange = "added" | "removed" | "signature" | "body" | "unchanged";

export type Compartment = "field" | "method";

export type Visibility = "+" | "-" | "#" | "~";

export interface LineRange {
  line: number;
  endLine: number;
}

export interface DiffedMember {
  key: string;
  name: string;
  kind: VizMemberKind;
  visibility?: Visibility;
  isStatic: boolean;
  isAbstract: boolean;
  label: string;
  short: string;
  previousLabel?: string;
  change: MemberChange;
  counts: LineCounts;
  span: SourceSpan;
}

export interface MemberRef extends LineRange {
  key: string;
  text: string;
}

export interface TypeRefs {
  head: LineRange;
  supertypes: string[];
  realizes: string[];
  fields: MemberRef[];
  methods: MemberRef[];
}

export interface DiffedType {
  key: string;
  name: string;
  kind: TypeKind;
  isAbstract: boolean;
  change: TypeChange;
  headerChanged: boolean;
  counts: LineCounts;
  members: DiffedMember[];
  span: SourceSpan;
  refs: { base?: TypeRefs; modified?: TypeRefs };
}

export interface GeneratedFileModel {
  repo: string;
  path: string;
  oldPath?: string;
  status: VizFileStatus;
  counts: LineCounts;
  types?: DiffedType[];
}

export interface ContextType {
  repo: string;
  path: string;
  name: string;
  kind: ContextKind;
  line: number;
}

export interface TypeSite {
  repo: string;
  path: string;
  type: string;
}

export interface RepoLine {
  repo: string;
  path: string;
  line: number;
}

export interface DefinitionQuery extends LineRange {
  from: TypeSite;
  name: string;
}

export interface DefinitionHit {
  from: TypeSite;
  name: string;
  target: RepoLine;
}

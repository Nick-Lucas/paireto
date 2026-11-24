import type { VizMember, VizNode } from "../../protocol/viz.js";
import {
  boxRows,
  changeSize,
  chipOf,
  formatCounts,
  summaryText,
  type BoxRows,
  type Chip,
  type Show,
  type SummaryRow,
} from "../model/visible.js";
import { fileRefLabel } from "../model/refs.js";
import { fitText, type Measure } from "./measure.js";

export const BOX = {
  padX: 10,
  headerPadY: 7,
  stereotypeHeight: 14,
  refHeight: 14,
  nameHeight: 18,
  rowHeight: 20,
  compartmentPadY: 5,
  chipWidth: 16,
  gap: 12,
  pillPadX: 6,
  minWidth: 150,
  contextMinWidth: 110,
  maxWidth: 380,
  readSlot: 12,
} as const;

export const NO_DIFF = "no diff";

const STEREOTYPES: Partial<Record<VizNode["kind"], string>> = {
  interface: "interface",
  enum: "enumeration",
  struct: "struct",
  module: "module",
  file: "file",
};

export function stereotypeOf(node: VizNode): string | undefined {
  return node.stereotype ?? STEREOTYPES[node.kind];
}

export interface MemberRowLayout {
  readonly kind: "member";
  readonly memberId: string;
  readonly text: string;
  readonly full: string;
  readonly chip: Chip | undefined;
  readonly counts: string | undefined;
  readonly removed: boolean;
  readonly isStatic: boolean;
  readonly isAbstract: boolean;
  readonly y: number;
}

export interface SummaryRowLayout {
  readonly kind: "summary";
  readonly row: SummaryRow;
  readonly text: string;
  readonly y: number;
}

export type BoxRowLayout = MemberRowLayout | SummaryRowLayout;

export interface ClassBoxLayout {
  readonly width: number;
  readonly height: number;
  readonly headerHeight: number;
  readonly stereotype: string | undefined;
  readonly title: string;
  readonly ref: string | undefined;
  readonly chip: Chip | undefined;
  readonly counts: string | undefined;
  readonly noDiff: boolean;
  readonly rows: readonly BoxRowLayout[];
  readonly dividers: readonly number[];
}

function pillWidth(text: string, measure: Measure): number {
  return measure(text, "small") + BOX.pillPadX * 2 + 2;
}

interface RowSpec {
  readonly member?: VizMember;
  readonly summary?: SummaryRow;
  readonly text: string;
  readonly counts?: string;
  readonly compartment: "fields" | "methods" | "summary";
}

function rowSpecs(rows: BoxRows): RowSpec[] {
  const specs: RowSpec[] = [];
  for (const compartment of ["fields", "methods"] as const) {
    for (const member of rows[compartment]) {
      specs.push({
        member,
        text: member.short ?? member.label,
        counts: changeSize(member) > 0 ? formatCounts(member.counts!) : undefined,
        compartment,
      });
    }
  }
  for (const summary of rows.summary) {
    specs.push({ summary, text: summaryText(summary), compartment: "summary" });
  }
  return specs;
}

export function measureClassBox(
  node: VizNode,
  show: Show,
  expanded: boolean,
  measure: Measure,
  commented: ReadonlySet<string> = new Set(),
): ClassBoxLayout {
  const stereotype = stereotypeOf(node);
  const stereotypeText = stereotype ? `«${stereotype}»` : undefined;
  const noDiff = node.delta === "unchanged";
  const chip = chipOf(node);
  const counts = !noDiff && changeSize(node) > 0 ? formatCounts(node.counts!) : undefined;
  const headerExtras =
    (counts ? BOX.gap + pillWidth(counts, measure) : 0) +
    (noDiff ? BOX.gap + pillWidth(NO_DIFF, measure) : BOX.readSlot);
  const file = node.files?.[0];
  const refText = file ? fileRefLabel(file) : undefined;
  const headerNeed =
    BOX.padX * 2 +
    Math.max(
      BOX.chipWidth + measure(node.label, "title") + headerExtras,
      BOX.chipWidth + (stereotypeText ? measure(stereotypeText, "small") : 0),
      refText ? measure(refText, "small") : 0,
    );
  const specs = rowSpecs(boxRows(node, show, expanded, commented));
  const rowNeed = Math.max(
    0,
    ...specs.map((spec) =>
      spec.member
        ? BOX.padX * 2 +
          BOX.chipWidth +
          measure(spec.text, "code") +
          (spec.counts ? BOX.gap + measure(spec.counts, "small") : 0)
        : BOX.padX * 2 + BOX.chipWidth + measure(spec.text, "small"),
    ),
  );
  const minWidth = noDiff ? BOX.contextMinWidth : BOX.minWidth;
  const width = Math.round(Math.min(BOX.maxWidth, Math.max(minWidth, headerNeed, rowNeed)));
  const titleRoom = width - BOX.padX * 2 - BOX.chipWidth - headerExtras;
  const title = fitText(node.label, "title", titleRoom, measure);
  const headerHeight =
    BOX.headerPadY * 2 +
    BOX.nameHeight +
    (stereotypeText ? BOX.stereotypeHeight : 0) +
    (refText ? BOX.refHeight : 0);

  const rows: BoxRowLayout[] = [];
  const dividers: number[] = [];
  let y = headerHeight;
  let previous: string | undefined;
  for (const spec of specs) {
    if (spec.compartment !== previous) {
      if (previous !== undefined) {
        y += BOX.compartmentPadY;
      }
      dividers.push(y);
      y += BOX.compartmentPadY;
      previous = spec.compartment;
    }
    const room =
      width -
      BOX.padX * 2 -
      BOX.chipWidth -
      (spec.counts ? BOX.gap + measure(spec.counts, "small") : 0);
    if (spec.member) {
      rows.push({
        kind: "member",
        memberId: spec.member.id,
        text: fitText(spec.text, "code", room, measure),
        full: spec.member.label,
        chip: chipOf(spec.member),
        counts: spec.counts,
        removed: spec.member.delta === "removed",
        isStatic: spec.member.isStatic === true,
        isAbstract: spec.member.isAbstract === true,
        y,
      });
    } else if (spec.summary) {
      rows.push({
        kind: "summary",
        row: spec.summary,
        text: fitText(spec.text, "small", room, measure),
        y,
      });
    }
    y += BOX.rowHeight;
  }
  if (rows.length > 0) {
    y += BOX.compartmentPadY;
  }
  return {
    width,
    height: y,
    headerHeight,
    stereotype: stereotypeText,
    title,
    ref: refText ? fitText(refText, "small", width - BOX.padX * 2, measure) : undefined,
    chip,
    counts,
    noDiff,
    rows,
    dividers,
  };
}

export function rowCentre(box: ClassBoxLayout, memberId: string): number | undefined {
  const row = box.rows.find(
    (candidate) => candidate.kind === "member" && candidate.memberId === memberId,
  );
  return row ? row.y + BOX.rowHeight / 2 : undefined;
}

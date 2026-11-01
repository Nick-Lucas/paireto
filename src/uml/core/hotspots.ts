import type { FocusedView } from "./focus.js";
import {
  changeSize,
  type LineCounts,
  type MemberChange,
  type TypeChange,
  type TypeKind,
} from "./model.js";

export interface HotspotMember {
  memberId: string;
  short: string;
  change: MemberChange;
  counts: LineCounts;
}

export interface Hotspot {
  typeId: string;
  name: string;
  kind: TypeKind;
  change: TypeChange;
  fileKey: string;
  counts: LineCounts;
  size: number;
  share: number;
  members: HotspotMember[];
}

const HOTSPOT_MEMBERS = 3;

export function hotspots(view: FocusedView): Hotspot[] {
  const ranked = view.types
    .filter((t) => t.role === "primary")
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  const largest = Math.max(1, ...ranked.map((t) => changeSize(t.type.counts)));
  return ranked.map(({ type, members }) => ({
    typeId: type.id,
    name: type.name,
    kind: type.kind,
    change: type.change,
    fileKey: type.fileKey,
    counts: type.counts,
    size: changeSize(type.counts),
    share: changeSize(type.counts) / largest,
    members: members
      .filter((m) => changeSize(m.counts) > 0)
      .sort((a, b) => changeSize(b.counts) - changeSize(a.counts))
      .slice(0, HOTSPOT_MEMBERS)
      .map((m) => ({
        memberId: m.id,
        short: m.visibility ? m.short.slice(m.visibility.length + 1) : m.short,
        change: m.change,
        counts: m.counts,
      })),
  }));
}

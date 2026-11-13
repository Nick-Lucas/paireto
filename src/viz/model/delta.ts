import type { VizDelta } from "../../protocol/viz.js";

export const DELTA_GLYPH: Record<VizDelta, string> = {
  added: "+",
  changed: "~",
  deleted: "−",
  unchanged: "·",
};

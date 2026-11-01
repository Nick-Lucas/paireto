export const PANEL_MIN_WIDTH = 180;
export const DIAGRAM_MIN_WIDTH = 240;

export function panelWidth(width: number, room: number): number {
  const widest = Math.max(PANEL_MIN_WIDTH, room - DIAGRAM_MIN_WIDTH);
  return Math.round(Math.min(widest, Math.max(PANEL_MIN_WIDTH, width)));
}

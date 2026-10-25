export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type Camera = "auto" | "wide" | { readonly rect: Rect; readonly zoom?: number };

export type TimelineEvent =
  | {
      readonly kind: "move";
      readonly start: number;
      readonly end: number;
      readonly from: Point;
      readonly to: Point;
    }
  | { readonly kind: "click"; readonly at: number; readonly point: Point; readonly count: number }
  | {
      readonly kind: "focus";
      readonly start: number;
      readonly end: number;
      readonly rect: Rect;
      readonly zoom?: number;
    }
  | { readonly kind: "wide"; readonly start: number; readonly end: number }
  | { readonly kind: "keys"; readonly at: number; readonly label: string }
  | { readonly kind: "chapter"; readonly at: number; readonly title: string }
  | { readonly kind: "fastForward"; readonly start: number; readonly end: number }
  | { readonly kind: "cut"; readonly start: number; readonly end: number };

export interface Timeline {
  readonly video: {
    readonly file: string;
    readonly fps: number;
    readonly width: number;
    readonly height: number;
    readonly scale: number;
    readonly durationMs: number;
  };
  readonly events: readonly TimelineEvent[];
}

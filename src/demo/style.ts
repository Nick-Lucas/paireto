import type { EditStyle } from "./edit.js";

export interface VideoStyle extends EditStyle {
  readonly background: readonly [string, string];
  readonly glow: readonly [string, string];
  readonly accent: string;
  readonly fontFamily: string;
  readonly cornerRadius: number;
  readonly cursorSize: number;
  readonly showKeys: boolean;
  readonly logo: string;
  readonly intro: { readonly tagline: string };
  readonly outro: { readonly headline: string; readonly subline: string };
}
